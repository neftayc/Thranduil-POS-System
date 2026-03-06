-- Modelo de categorias de producto (normaliza product_type a catalogo maestro)

create table if not exists public.product_categories (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  active boolean not null default true,
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_product_categories_active_sort
  on public.product_categories (active, sort_order, name);

alter table public.products add column if not exists category_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'products_category_id_fkey'
  ) then
    alter table public.products
      add constraint products_category_id_fkey
      foreign key (category_id) references public.product_categories(id) on delete set null;
  end if;
end $$;

create index if not exists idx_products_category_id on public.products (category_id);

create or replace function public.normalize_category_code(p_value text)
returns text
language sql
immutable
as $$
  select trim(both '_' from regexp_replace(
    regexp_replace(public.normalize_uom_code(coalesce(p_value, '')), '\s+', '_', 'g'),
    '[^[:alnum:]_]+',
    '',
    'g'
  ));
$$;

create or replace function public.ensure_product_category(p_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
  v_code text;
  v_id uuid;
  v_sort_order integer;
begin
  v_name := nullif(trim(p_name), '');
  if v_name is null then
    return null;
  end if;

  select c.id
    into v_id
    from public.product_categories c
    where public.normalize_uom_code(c.name) = public.normalize_uom_code(v_name)
    limit 1;

  if v_id is not null then
    return v_id;
  end if;

  v_code := public.normalize_category_code(v_name);
  if v_code = '' then
    v_code := 'cat_' || substr(md5(v_name || clock_timestamp()::text), 1, 12);
  end if;

  select c.id
    into v_id
    from public.product_categories c
    where c.code = v_code
    limit 1;

  if v_id is not null then
    return v_id;
  end if;

  select coalesce(max(c.sort_order), 0) + 10
    into v_sort_order
    from public.product_categories c;

  insert into public.product_categories (code, name, active, sort_order, updated_at)
  values (v_code, v_name, true, v_sort_order, now())
  on conflict (code) do update
    set name = excluded.name,
        updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.products_category_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_category_name text;
  v_category_id uuid;
begin
  if new.category_id is not null then
    select c.name
      into v_category_name
      from public.product_categories c
      where c.id = new.category_id
      limit 1;

    if v_category_name is null then
      raise exception 'Categoria inválida';
    end if;

    new.product_type := v_category_name;
    return new;
  end if;

  v_category_name := nullif(trim(new.product_type), '');
  if v_category_name is null then
    new.product_type := null;
    return new;
  end if;

  v_category_id := public.ensure_product_category(v_category_name);
  if v_category_id is not null then
    new.category_id := v_category_id;
    select c.name
      into v_category_name
      from public.product_categories c
      where c.id = v_category_id
      limit 1;
    if v_category_name is not null then
      new.product_type := v_category_name;
    end if;
  end if;

  return new;
end;
$$;

update public.products
set category_id = public.ensure_product_category(product_type)
where category_id is null
  and nullif(trim(product_type), '') is not null;

update public.products p
set product_type = c.name
from public.product_categories c
where p.category_id = c.id
  and coalesce(p.product_type, '') <> coalesce(c.name, '');

drop trigger if exists trg_products_category_guard on public.products;
create trigger trg_products_category_guard
before insert or update of category_id, product_type on public.products
for each row
execute function public.products_category_guard();

create or replace view public.product_catalog
with (security_invoker = true)
as
select
  p.id,
  p.sku,
  p.name,
  p.description,
  p.brand,
  coalesce(pcat.name, p.product_type) as product_type,
  p.unit,
  p.barcode,
  p.tax_code,
  p.taxable,
  p.active,
  coalesce(cp.sale_price, p.sale_price, 0) as sale_price,
  coalesce(inv.stock_on_hand, p.stock_on_hand, 0) as stock_on_hand,
  coalesce(pcost.avg_purchase_cost, inv.avg_cost, p.avg_cost, 0) as avg_cost,
  coalesce(inv.min_stock, p.min_stock, 0) as min_stock,
  cp.currency,
  p.created_at,
  p.updated_at,
  coalesce(pcost.last_purchase_cost, 0) as last_purchase_cost,
  coalesce(fifo.fifo_stock_qty, 0) as fifo_stock_qty,
  coalesce(fifo.fifo_stock_value, 0) as fifo_stock_value,
  coalesce(fifo.fifo_next_cost, 0) as fifo_next_cost,
  coalesce(uom.needs_presentation_setup, false) as needs_presentation_setup,
  coalesce(uom.missing_purchase_units, array[]::text[]) as missing_purchase_units,
  coalesce(fifo.fifo_next_qty, 0) as fifo_next_qty,
  p.category_id,
  pcat.code as category_code,
  pcat.name as category_name
from public.products p
left join public.product_categories pcat on pcat.id = p.category_id
left join lateral (
  select pp.sale_price, pp.currency
  from public.product_prices pp
  where pp.product_id = p.id
    and pp.price_list = 'retail'
    and pp.is_current = true
  order by pp.valid_from desc, pp.created_at desc
  limit 1
) cp on true
left join lateral (
  with base_unit as (
    select coalesce(public.resolve_uom_code(p.unit), public.normalize_uom_code(p.unit), 'unidad') as base_unit_code
  ),
  purchase_units as (
    select distinct coalesce(public.resolve_uom_code(pi.unit_name), public.normalize_uom_code(pi.unit_name), 'unidad') as unit_code
    from public.purchase_items pi
    where pi.product_id = p.id
  ),
  missing as (
    select pu.unit_code
    from purchase_units pu
    cross join base_unit bu
    where pu.unit_code <> bu.base_unit_code
      and not exists (
        select 1
        from public.product_unit_conversions puc
        where puc.product_id = p.id
          and coalesce(public.resolve_uom_code(puc.unit_name), public.normalize_uom_code(puc.unit_name), 'unidad') = pu.unit_code
          and puc.is_active = true
      )
  )
  select
    (select count(*) > 0 from missing) as needs_presentation_setup,
    coalesce((select array_agg(m.unit_code order by m.unit_code) from missing m), array[]::text[]) as missing_purchase_units
) uom on true
left join lateral (
  with pi_norm as (
    select
      pi.id,
      coalesce(pi.total_cost, 0)::numeric as total_cost,
      coalesce(pi.cost_unit, 0)::numeric as cost_unit_base,
      coalesce(pi.qty, 0)::numeric as qty_base_recorded,
      coalesce(pi.qty_uom, 0)::numeric as qty_uom_recorded,
      coalesce(pi.factor_to_base, 0)::numeric as factor_item,
      coalesce(puc.factor_to_base, 0)::numeric as factor_catalog,
      coalesce(public.resolve_uom_code(pi.unit_name), public.normalize_uom_code(pi.unit_name), 'unidad') as unit_code,
      coalesce(public.resolve_uom_code(p.unit), public.normalize_uom_code(p.unit), 'unidad') as base_unit_code,
      coalesce(pu.purchase_date, pu.created_at, pi.created_at, now()) as purchase_dt,
      coalesce(pi.created_at, pu.created_at, now()) as item_dt
    from public.purchase_items pi
    join public.purchases pu on pu.id = pi.purchase_id
    left join public.product_unit_conversions puc
      on puc.product_id = pi.product_id
     and coalesce(public.resolve_uom_code(puc.unit_name), public.normalize_uom_code(puc.unit_name), 'unidad')
         = coalesce(public.resolve_uom_code(pi.unit_name), public.normalize_uom_code(pi.unit_name), 'unidad')
     and puc.is_active = true
    where pi.product_id = p.id
  ),
  pi_calc as (
    select
      id,
      total_cost,
      cost_unit_base,
      purchase_dt,
      item_dt,
      qty_uom_recorded,
      case
        when unit_code = base_unit_code then 1::numeric
        when factor_catalog > 0 then factor_catalog
        else null
      end as factor_effective
    from pi_norm
  ),
  pi_metrics as (
    select
      id,
      total_cost,
      purchase_dt,
      item_dt,
      case
        when qty_uom_recorded > 0 and factor_effective > 0 then qty_uom_recorded * factor_effective
        else 0
      end as qty_base_effective,
      case
        when (
          case
            when qty_uom_recorded > 0 and factor_effective > 0 then qty_uom_recorded * factor_effective
            else 0
          end
        ) > 0 then round((
          total_cost / (
            case
              when qty_uom_recorded > 0 and factor_effective > 0 then qty_uom_recorded * factor_effective
              else 1
            end
          )
        )::numeric, 4)
        else cost_unit_base
      end as cost_unit_effective
    from pi_calc
  )
  select
    case
      when sum(pi_metrics.qty_base_effective) > 0 then round((sum(pi_metrics.total_cost) / sum(pi_metrics.qty_base_effective))::numeric, 4)
      else null
    end as avg_purchase_cost,
    (
      select m.cost_unit_effective
      from pi_metrics m
      order by m.purchase_dt desc, m.item_dt desc, m.id desc
      limit 1
    ) as last_purchase_cost
  from pi_metrics
) pcost on true
left join lateral (
  with base_unit as (
    select coalesce(public.resolve_uom_code(p.unit), public.normalize_uom_code(p.unit), 'unidad') as base_unit_code
  ),
  purchase_raw as (
    select
      pi.id,
      coalesce(pu.purchase_date, pu.created_at, pi.created_at, now()) as purchase_dt,
      coalesce(pi.created_at, pu.created_at, now()) as item_dt,
      coalesce(pi.total_cost, 0)::numeric as total_cost,
      coalesce(pi.qty_uom, 0)::numeric as qty_uom_raw,
      coalesce(public.resolve_uom_code(pi.unit_name), public.normalize_uom_code(pi.unit_name), 'unidad') as unit_code,
      coalesce(puc.factor_to_base, 0)::numeric as factor_catalog,
      bu.base_unit_code
    from public.purchase_items pi
    join public.purchases pu on pu.id = pi.purchase_id
    cross join base_unit bu
    left join public.product_unit_conversions puc
      on puc.product_id = pi.product_id
     and coalesce(public.resolve_uom_code(puc.unit_name), public.normalize_uom_code(puc.unit_name), 'unidad')
         = coalesce(public.resolve_uom_code(pi.unit_name), public.normalize_uom_code(pi.unit_name), 'unidad')
     and puc.is_active = true
    where pi.product_id = p.id
  ),
  purchase_metrics as (
    select
      pr.id,
      pr.purchase_dt,
      pr.item_dt,
      case
        when pr.unit_code = pr.base_unit_code then 1::numeric
        when pr.factor_catalog > 0 then pr.factor_catalog
        else null
      end as factor_effective,
      pr.qty_uom_raw,
      pr.total_cost
    from purchase_raw pr
  ),
  purchase_layers as (
    select
      pm.id,
      pm.purchase_dt,
      pm.item_dt,
      (pm.qty_uom_raw * pm.factor_effective)::numeric as qty_base_effective,
      case
        when (pm.qty_uom_raw * pm.factor_effective) > 0 then round((pm.total_cost / (pm.qty_uom_raw * pm.factor_effective))::numeric, 4)
        else 0::numeric
      end as cost_base_effective
    from purchase_metrics pm
    where pm.factor_effective > 0
      and pm.qty_uom_raw > 0
  ),
  sales_raw as (
    select
      si.id,
      coalesce(s.sale_date, s.created_at, si.created_at, now()) as sale_dt,
      coalesce(si.qty_uom, 0)::numeric as qty_uom_raw,
      coalesce(public.resolve_uom_code(si.unit_name), public.normalize_uom_code(si.unit_name), 'unidad') as unit_code,
      coalesce(puc.factor_to_base, 0)::numeric as factor_catalog,
      bu.base_unit_code
    from public.sale_items si
    join public.sales s on s.id = si.sale_id
    cross join base_unit bu
    left join public.product_unit_conversions puc
      on puc.product_id = si.product_id
     and coalesce(public.resolve_uom_code(puc.unit_name), public.normalize_uom_code(puc.unit_name), 'unidad')
         = coalesce(public.resolve_uom_code(si.unit_name), public.normalize_uom_code(si.unit_name), 'unidad')
     and puc.is_active = true
    where si.product_id = p.id
  ),
  sales_metrics as (
    select
      sr.id,
      sr.sale_dt,
      case
        when sr.unit_code = sr.base_unit_code then 1::numeric
        when sr.factor_catalog > 0 then sr.factor_catalog
        else null
      end as factor_effective,
      sr.qty_uom_raw
    from sales_raw sr
  ),
  sold_total as (
    select coalesce(sum(sm.qty_uom_raw * sm.factor_effective), 0)::numeric as qty_sold_base
    from sales_metrics sm
    where sm.factor_effective > 0
      and sm.qty_uom_raw > 0
  ),
  purchase_ranked as (
    select
      pl.*,
      sum(pl.qty_base_effective) over (order by pl.purchase_dt asc, pl.item_dt asc, pl.id asc) as purchased_cum,
      coalesce(
        sum(pl.qty_base_effective) over (
          order by pl.purchase_dt asc, pl.item_dt asc, pl.id asc
          rows between unbounded preceding and 1 preceding
        ),
        0
      ) as purchased_cum_prev
    from purchase_layers pl
  ),
  layer_remaining as (
    select
      pr.purchase_dt,
      pr.item_dt,
      pr.id,
      pr.cost_base_effective,
      greatest(
        0::numeric,
        pr.qty_base_effective - greatest(
          0::numeric,
          least(pr.qty_base_effective, st.qty_sold_base - pr.purchased_cum_prev)
        )
      ) as qty_remaining_effective
    from purchase_ranked pr
    cross join sold_total st
  )
  select
    coalesce(sum(lr.qty_remaining_effective), 0)::numeric(12,3) as fifo_stock_qty,
    coalesce(sum(lr.qty_remaining_effective * lr.cost_base_effective), 0)::numeric(14,4) as fifo_stock_value,
    (
      select lr2.cost_base_effective
      from layer_remaining lr2
      where lr2.qty_remaining_effective > 0
      order by lr2.purchase_dt asc, lr2.item_dt asc, lr2.id asc
      limit 1
    )::numeric(12,4) as fifo_next_cost,
    (
      select lr2.qty_remaining_effective
      from layer_remaining lr2
      where lr2.qty_remaining_effective > 0
      order by lr2.purchase_dt asc, lr2.item_dt asc, lr2.id asc
      limit 1
    )::numeric(12,3) as fifo_next_qty
  from layer_remaining lr
) fifo on true
left join public.inventory_balances inv on inv.product_id = p.id;

create or replace function public.upsert_product_catalog(
  p_id uuid,
  p_sku text,
  p_name text,
  p_unit text,
  p_brand text,
  p_product_type text,
  p_barcode text,
  p_active boolean,
  p_sale_price numeric,
  p_min_stock numeric,
  p_stock_on_hand numeric default null,
  p_avg_cost numeric default null,
  p_currency text default 'PEN'
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product_id uuid;
  v_price_id uuid;
  v_current_price numeric;
  v_currency char(3);
  v_base_unit text;
  v_category_id uuid;
  v_category_name text;
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  if coalesce(trim(p_name), '') = '' then
    raise exception 'Nombre de producto obligatorio';
  end if;

  v_currency := upper(coalesce(nullif(trim(p_currency), ''), 'PEN'))::char(3);
  v_base_unit := public.require_uom_code(coalesce(nullif(trim(p_unit), ''), 'unidad'));
  v_category_name := nullif(trim(p_product_type), '');
  if v_category_name is not null then
    v_category_id := public.ensure_product_category(v_category_name);
    if v_category_id is not null then
      select c.name
        into v_category_name
        from public.product_categories c
        where c.id = v_category_id
        limit 1;
    end if;
  end if;

  if p_id is null and nullif(trim(p_sku), '') is not null then
    select id
      into v_product_id
      from public.products
      where sku = nullif(trim(p_sku), '')
      limit 1;
  end if;

  if p_id is null and v_product_id is null then
    insert into public.products (
      sku,
      name,
      unit,
      brand,
      category_id,
      product_type,
      barcode,
      active,
      sale_price,
      min_stock,
      updated_at
    ) values (
      nullif(trim(p_sku), ''),
      p_name,
      v_base_unit,
      nullif(trim(p_brand), ''),
      v_category_id,
      coalesce(v_category_name, nullif(trim(p_product_type), '')),
      nullif(trim(p_barcode), ''),
      coalesce(p_active, true),
      coalesce(p_sale_price, 0),
      coalesce(p_min_stock, 0),
      now()
    )
    returning id into v_product_id;
  else
    update public.products
      set sku = nullif(trim(p_sku), ''),
          name = p_name,
          unit = v_base_unit,
          brand = nullif(trim(p_brand), ''),
          category_id = coalesce(v_category_id, category_id),
          product_type = coalesce(v_category_name, product_type),
          barcode = nullif(trim(p_barcode), ''),
          active = coalesce(p_active, true),
          sale_price = coalesce(p_sale_price, 0),
          min_stock = coalesce(p_min_stock, 0),
          updated_at = now()
      where id = coalesce(p_id, v_product_id)
      returning id into v_product_id;

    if v_product_id is null then
      raise exception 'Producto no encontrado';
    end if;
  end if;

  insert into public.inventory_balances (product_id, stock_on_hand, avg_cost, min_stock, updated_at)
  values (
    v_product_id,
    coalesce(p_stock_on_hand, 0),
    coalesce(p_avg_cost, 0),
    coalesce(p_min_stock, 0),
    now()
  )
  on conflict (product_id) do nothing;

  update public.inventory_balances
    set stock_on_hand = coalesce(p_stock_on_hand, stock_on_hand),
        avg_cost = coalesce(p_avg_cost, avg_cost),
        min_stock = coalesce(p_min_stock, min_stock),
        updated_at = now()
    where product_id = v_product_id;

  select pp.id, pp.sale_price
    into v_price_id, v_current_price
    from public.product_prices pp
    where pp.product_id = v_product_id
      and pp.price_list = 'retail'
      and pp.currency = v_currency
      and pp.is_current = true
    order by pp.valid_from desc, pp.created_at desc
    limit 1;

  if v_price_id is null then
    insert into public.product_prices (
      product_id,
      price_list,
      regular_price,
      sale_price,
      currency,
      valid_from,
      is_current,
      created_by
    ) values (
      v_product_id,
      'retail',
      coalesce(p_sale_price, 0),
      coalesce(p_sale_price, 0),
      v_currency,
      now(),
      true,
      auth.uid()
    );
  elsif coalesce(v_current_price, 0) <> coalesce(p_sale_price, 0) then
    update public.product_prices
      set is_current = false,
          valid_to = now()
      where id = v_price_id;

    insert into public.product_prices (
      product_id,
      price_list,
      regular_price,
      sale_price,
      currency,
      valid_from,
      is_current,
      created_by
    ) values (
      v_product_id,
      'retail',
      coalesce(p_sale_price, 0),
      coalesce(p_sale_price, 0),
      v_currency,
      now(),
      true,
      auth.uid()
    );
  end if;

  update public.products
    set sale_price = coalesce(p_sale_price, 0),
        stock_on_hand = coalesce(p_stock_on_hand, stock_on_hand),
        avg_cost = coalesce(p_avg_cost, avg_cost),
        min_stock = coalesce(p_min_stock, 0),
        updated_at = now()
    where id = v_product_id;

  return v_product_id;
end;
$$;

grant select on public.product_categories to authenticated;

alter table public.product_categories enable row level security;
drop policy if exists "product_categories_select_auth" on public.product_categories;
create policy "product_categories_select_auth" on public.product_categories
  for select using (auth.uid() is not null);
drop policy if exists "product_categories_insert_owner" on public.product_categories;
create policy "product_categories_insert_owner" on public.product_categories
  for insert with check (public.is_owner());
drop policy if exists "product_categories_update_owner" on public.product_categories;
create policy "product_categories_update_owner" on public.product_categories
  for update using (public.is_owner())
  with check (public.is_owner());
drop policy if exists "product_categories_delete_owner" on public.product_categories;
create policy "product_categories_delete_owner" on public.product_categories
  for delete using (public.is_owner());
