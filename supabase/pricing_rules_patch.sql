-- Patch: reglas de venta (presentación, mayorista, promoción, tipo de cliente, descuento manual)
-- Ejecutar en Supabase SQL Editor

create table if not exists public.customer_groups (
  code text primary key,
  label text not null,
  active boolean not null default true,
  sort_order integer not null default 100,
  created_at timestamptz not null default now()
);

insert into public.customer_groups (code, label, active, sort_order)
values
  ('minorista', 'Minorista', true, 10),
  ('mayorista', 'Mayorista', true, 20),
  ('institucional', 'Institucional', true, 30)
on conflict (code) do update
set label = excluded.label,
    active = excluded.active,
    sort_order = excluded.sort_order;

alter table public.customers add column if not exists customer_group text;
update public.customers c
set customer_group = 'minorista'
where coalesce(trim(c.customer_group), '') = ''
   or not exists (
     select 1
     from public.customer_groups g
     where g.code = c.customer_group
   );

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'customers_customer_group_fkey'
      and conrelid = 'public.customers'::regclass
  ) then
    alter table public.customers
      add constraint customers_customer_group_fkey
      foreign key (customer_group) references public.customer_groups (code) on update cascade;
  end if;
end $$;

alter table public.customers alter column customer_group set default 'minorista';

create table if not exists public.product_customer_group_prices (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products on delete cascade,
  customer_group text references public.customer_groups (code) on update cascade,
  unit_price_base numeric(12,4) not null check (unit_price_base >= 0),
  currency char(3) not null default 'PEN',
  starts_at timestamptz,
  ends_at timestamptz,
  priority integer not null default 100,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_product_customer_group_prices_product
  on public.product_customer_group_prices (product_id, customer_group, active, priority);

create table if not exists public.product_presentation_prices (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products on delete cascade,
  unit_name text not null references public.uom_catalog (code) on update cascade,
  customer_group text references public.customer_groups (code) on update cascade,
  price_uom numeric(12,4) not null check (price_uom >= 0),
  currency char(3) not null default 'PEN',
  starts_at timestamptz,
  ends_at timestamptz,
  priority integer not null default 100,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_product_presentation_prices_product
  on public.product_presentation_prices (product_id, unit_name, customer_group, active, priority);

create table if not exists public.product_wholesale_tiers (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products on delete cascade,
  customer_group text references public.customer_groups (code) on update cascade,
  min_qty_base numeric(12,3) not null check (min_qty_base > 0),
  unit_price_base numeric(12,4) not null check (unit_price_base >= 0),
  starts_at timestamptz,
  ends_at timestamptz,
  priority integer not null default 100,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_product_wholesale_tiers_product
  on public.product_wholesale_tiers (product_id, customer_group, min_qty_base desc, active, priority);

create table if not exists public.product_promotions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  product_id uuid not null references public.products on delete cascade,
  unit_name text references public.uom_catalog (code) on update cascade,
  customer_group text references public.customer_groups (code) on update cascade,
  promo_type text not null check (promo_type in ('percent', 'fixed_price_uom')),
  promo_value numeric(12,4) not null check (promo_value > 0),
  min_qty_base numeric(12,3) not null default 1 check (min_qty_base > 0),
  starts_at timestamptz not null,
  ends_at timestamptz,
  priority integer not null default 100,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_product_promotions_product
  on public.product_promotions (product_id, customer_group, unit_name, active, priority);

alter table public.sale_items add column if not exists auto_price_unit numeric(12,4) not null default 0;
alter table public.sale_items add column if not exists pricing_source text;
alter table public.sale_items add column if not exists pricing_detail jsonb not null default '{}'::jsonb;
alter table public.sale_items add column if not exists manual_discount_pct numeric(6,2) not null default 0;
alter table public.sale_items add column if not exists manual_discount_amount numeric(12,4) not null default 0;
alter table public.sale_items add column if not exists manual_discount_reason text;

create or replace function public.customer_group_for_sale(p_customer_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group text;
begin
  if p_customer_id is null then
    return 'minorista';
  end if;

  select c.customer_group
    into v_group
    from public.customers c
    where c.id = p_customer_id
    limit 1;

  if v_group is null then
    return 'minorista';
  end if;

  if not exists (
    select 1
    from public.customer_groups g
    where g.code = v_group
      and g.active = true
  ) then
    return 'minorista';
  end if;

  return v_group;
end;
$$;

create or replace function public.resolve_sale_item_pricing(
  p_product_id uuid,
  p_unit_name text,
  p_qty_uom numeric,
  p_customer_id uuid default null,
  p_sale_at timestamptz default now()
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base_unit text;
  v_unit_name text;
  v_factor numeric;
  v_qty_uom numeric;
  v_qty_base numeric;
  v_customer_group text;
  v_base_price numeric;
  v_price_base numeric;
  v_price_uom numeric;
  v_currency char(3);
  v_rule_id uuid;
  v_rule_type text := 'base';
  v_source text := 'base';
  v_candidate numeric;
  v_promo_type text;
  v_promo_value numeric;
begin
  select
    coalesce(nullif(trim(p.unit), ''), 'unidad'),
    coalesce(pc.sale_price, p.sale_price, 0),
    coalesce(pc.currency, 'PEN')
    into v_base_unit, v_base_price, v_currency
  from public.products p
  left join public.product_catalog pc on pc.id = p.id
  where p.id = p_product_id
  limit 1;

  if v_base_unit is null then
    raise exception 'Producto no encontrado';
  end if;

  v_base_unit := public.require_uom_code(v_base_unit);
  if coalesce(trim(p_unit_name), '') = '' then
    v_unit_name := v_base_unit;
  else
    v_unit_name := public.require_uom_code(p_unit_name);
  end if;

  v_factor := public.resolve_product_uom_factor(p_product_id, v_unit_name);
  v_qty_uom := greatest(coalesce(p_qty_uom, 0), 0);
  if v_qty_uom = 0 then
    v_qty_uom := 1;
  end if;
  v_qty_base := v_qty_uom * v_factor;
  v_customer_group := public.customer_group_for_sale(p_customer_id);

  v_price_base := coalesce(v_base_price, 0);

  -- Precio por tipo de cliente
  v_rule_id := null;
  select r.id, r.unit_price_base
    into v_rule_id, v_candidate
    from public.product_customer_group_prices r
    where r.product_id = p_product_id
      and r.active = true
      and (r.customer_group is null or r.customer_group = v_customer_group)
      and (r.starts_at is null or r.starts_at <= p_sale_at)
      and (r.ends_at is null or r.ends_at >= p_sale_at)
    order by
      case when r.customer_group = v_customer_group then 0 else 1 end,
      r.priority asc,
      r.starts_at desc nulls last,
      r.created_at desc
    limit 1;

  if v_rule_id is not null then
    v_price_base := v_candidate;
    v_rule_type := 'customer_group';
    v_source := 'customer_group';
  end if;

  v_price_uom := v_price_base * v_factor;

  -- Precio por presentación
  v_rule_id := null;
  select r.id, r.price_uom
    into v_rule_id, v_candidate
    from public.product_presentation_prices r
    where r.product_id = p_product_id
      and r.unit_name = v_unit_name
      and r.active = true
      and (r.customer_group is null or r.customer_group = v_customer_group)
      and (r.starts_at is null or r.starts_at <= p_sale_at)
      and (r.ends_at is null or r.ends_at >= p_sale_at)
    order by
      case when r.customer_group = v_customer_group then 0 else 1 end,
      r.priority asc,
      r.starts_at desc nulls last,
      r.created_at desc
    limit 1;

  if v_rule_id is not null then
    v_price_uom := v_candidate;
    v_price_base := case when v_factor = 0 then 0 else v_price_uom / v_factor end;
    v_rule_type := 'presentation';
    v_source := 'presentation';
  end if;

  -- Precio mayorista por cantidad
  v_rule_id := null;
  select r.id, r.unit_price_base
    into v_rule_id, v_candidate
    from public.product_wholesale_tiers r
    where r.product_id = p_product_id
      and r.active = true
      and r.min_qty_base <= v_qty_base
      and (r.customer_group is null or r.customer_group = v_customer_group)
      and (r.starts_at is null or r.starts_at <= p_sale_at)
      and (r.ends_at is null or r.ends_at >= p_sale_at)
    order by
      r.min_qty_base desc,
      case when r.customer_group = v_customer_group then 0 else 1 end,
      r.priority asc,
      r.created_at desc
    limit 1;

  if v_rule_id is not null then
    v_price_base := v_candidate;
    v_price_uom := v_price_base * v_factor;
    v_rule_type := 'wholesale';
    v_source := 'wholesale';
  end if;

  -- Promoción temporal
  v_rule_id := null;
  select p.id, p.promo_type, p.promo_value
    into v_rule_id, v_promo_type, v_promo_value
    from public.product_promotions p
    where p.product_id = p_product_id
      and p.active = true
      and p.min_qty_base <= v_qty_base
      and p.starts_at <= p_sale_at
      and (p.ends_at is null or p.ends_at >= p_sale_at)
      and (p.customer_group is null or p.customer_group = v_customer_group)
      and (p.unit_name is null or p.unit_name = v_unit_name)
    order by
      case when p.customer_group = v_customer_group then 0 else 1 end,
      case when p.unit_name = v_unit_name then 0 else 1 end,
      p.priority asc,
      p.starts_at desc,
      p.created_at desc
    limit 1;

  if v_rule_id is not null then
    if v_promo_type = 'percent' then
      v_price_uom := v_price_uom * (1 - (v_promo_value / 100));
      v_source := v_source || '+promo_percent';
      v_rule_type := 'promotion_percent';
    elsif v_promo_type = 'fixed_price_uom' then
      v_price_uom := v_promo_value;
      v_source := v_source || '+promo_fixed';
      v_rule_type := 'promotion_fixed';
    end if;
    v_price_base := case when v_factor = 0 then 0 else v_price_uom / v_factor end;
  end if;

  v_price_uom := greatest(round(v_price_uom::numeric, 4), 0);
  v_price_base := greatest(round(v_price_base::numeric, 4), 0);

  return jsonb_build_object(
    'price_uom', v_price_uom,
    'price_base', v_price_base,
    'factor', v_factor,
    'qty_base', v_qty_base,
    'unit_name', v_unit_name,
    'base_unit', v_base_unit,
    'customer_group', v_customer_group,
    'currency', v_currency,
    'source', v_source,
    'rule_type', v_rule_type
  );
end;
$$;

create or replace function public.create_sale(
  p_customer_id uuid,
  p_payment_method text,
  p_items jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale_id uuid;
  v_item jsonb;
  v_product_id uuid;
  v_qty_input numeric;
  v_price_input numeric;
  v_qty_base numeric;
  v_price_base numeric;
  v_unit_name text;
  v_base_unit text;
  v_factor numeric;
  v_old_stock numeric;
  v_old_avg numeric;
  v_min_stock numeric;
  v_product_name text;
  v_total numeric := 0;
  v_payment_method_code text;
  v_pricing jsonb;
  v_auto_price_uom numeric;
  v_final_price_uom numeric;
  v_manual_discount_pct numeric;
  v_manual_discount_amount numeric;
  v_manual_discount_reason text;
  v_role text;
  v_can_manual_discount boolean := false;
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'Items invalidos';
  end if;

  v_payment_method_code := coalesce(public.resolve_payment_method_code(p_payment_method), 'efectivo');
  v_role := coalesce(public.user_role(), 'cashier');
  v_can_manual_discount := v_role in ('owner', 'manager');

  insert into public.sales (customer_id, payment_method, created_by, total)
  values (p_customer_id, v_payment_method_code, auth.uid(), 0)
  returning id into v_sale_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_product_id := (v_item->>'product_id')::uuid;
    v_qty_input := coalesce(nullif(v_item->>'qty', '')::numeric, 0);
    v_price_input := nullif(v_item->>'price_unit', '')::numeric;
    v_manual_discount_pct := greatest(coalesce(nullif(v_item->>'manual_discount_pct', '')::numeric, 0), 0);
    v_manual_discount_amount := greatest(coalesce(nullif(v_item->>'manual_discount_amount', '')::numeric, 0), 0);
    v_manual_discount_reason := nullif(trim(coalesce(v_item->>'manual_discount_reason', '')), '');

    if v_qty_input <= 0 then
      raise exception 'Cantidad invalida';
    end if;

    if v_price_input is not null and v_price_input < 0 then
      raise exception 'Precio invalido';
    end if;

    select coalesce(nullif(trim(unit), ''), 'unidad')
      into v_base_unit
      from public.products
      where id = v_product_id;

    if v_base_unit is null then
      raise exception 'Producto no encontrado';
    end if;

    v_base_unit := public.require_uom_code(v_base_unit);
    if coalesce(trim(v_item->>'unit_name'), '') = '' then
      v_unit_name := v_base_unit;
    else
      v_unit_name := public.require_uom_code(v_item->>'unit_name');
    end if;

    v_pricing := public.resolve_sale_item_pricing(
      p_product_id := v_product_id,
      p_unit_name := v_unit_name,
      p_qty_uom := v_qty_input,
      p_customer_id := p_customer_id,
      p_sale_at := now()
    );

    v_factor := coalesce((v_pricing->>'factor')::numeric, 1);
    v_qty_base := coalesce((v_pricing->>'qty_base')::numeric, v_qty_input * v_factor);
    v_auto_price_uom := coalesce((v_pricing->>'price_uom')::numeric, 0);
    v_final_price_uom := v_auto_price_uom;

    if (
      v_manual_discount_pct > 0
      or v_manual_discount_amount > 0
      or (v_price_input is not null and abs(v_price_input - v_auto_price_uom) > 0.0001)
    ) then
      if not v_can_manual_discount then
        raise exception 'Tu rol no permite descuento o ajuste manual de precio';
      end if;
      if v_manual_discount_reason is null then
        raise exception 'Motivo obligatorio para descuento o ajuste manual';
      end if;
    end if;

    if v_manual_discount_pct > 0 then
      v_final_price_uom := v_final_price_uom * (1 - (v_manual_discount_pct / 100));
    end if;

    if v_manual_discount_amount > 0 then
      v_final_price_uom := v_final_price_uom - v_manual_discount_amount;
    end if;

    if v_price_input is not null and abs(v_price_input - v_auto_price_uom) > 0.0001 then
      v_final_price_uom := v_price_input;
    end if;

    v_final_price_uom := round(v_final_price_uom::numeric, 4);
    if v_final_price_uom < 0 then
      raise exception 'Precio final inválido para %', v_product_id;
    end if;

    v_price_base := case when v_factor = 0 then 0 else round((v_final_price_uom / v_factor)::numeric, 4) end;

    insert into public.inventory_balances (product_id, stock_on_hand, avg_cost, min_stock, updated_at)
    values (
      v_product_id,
      coalesce((select p.stock_on_hand from public.products p where p.id = v_product_id), 0),
      coalesce((select p.avg_cost from public.products p where p.id = v_product_id), 0),
      coalesce((select p.min_stock from public.products p where p.id = v_product_id), 0),
      now()
    )
    on conflict (product_id) do nothing;

    select ib.stock_on_hand, ib.avg_cost, ib.min_stock, p.name
      into v_old_stock, v_old_avg, v_min_stock, v_product_name
      from public.inventory_balances ib
      join public.products p on p.id = ib.product_id
      where ib.product_id = v_product_id
      for update;

    if v_old_stock < v_qty_base then
      raise exception 'Stock insuficiente para %', v_product_name;
    end if;

    update public.inventory_balances
      set stock_on_hand = v_old_stock - v_qty_base,
          updated_at = now()
      where product_id = v_product_id;

    update public.products
      set stock_on_hand = v_old_stock - v_qty_base,
          avg_cost = v_old_avg,
          min_stock = coalesce(v_min_stock, min_stock),
          updated_at = now()
      where id = v_product_id;

    insert into public.sale_items (
      sale_id,
      product_id,
      unit_name,
      qty_uom,
      factor_to_base,
      price_unit_uom,
      qty,
      price_unit,
      auto_price_unit,
      pricing_source,
      pricing_detail,
      manual_discount_pct,
      manual_discount_amount,
      manual_discount_reason,
      total
    )
    values (
      v_sale_id,
      v_product_id,
      v_unit_name,
      v_qty_input,
      v_factor,
      v_final_price_uom,
      v_qty_base,
      v_price_base,
      v_auto_price_uom,
      coalesce(v_pricing->>'source', 'base'),
      v_pricing,
      v_manual_discount_pct,
      v_manual_discount_amount,
      v_manual_discount_reason,
      v_qty_input * v_final_price_uom
    );

    insert into public.stock_movements (product_id, movement_type, qty, cost_unit, ref_table, ref_id, created_by)
    values (v_product_id, 'sale', -v_qty_base, v_old_avg, 'sales', v_sale_id, auth.uid());

    v_total := v_total + (v_qty_input * v_final_price_uom);
  end loop;

  update public.sales
    set total = v_total
    where id = v_sale_id;

  return v_sale_id;
end;
$$;

grant execute on function public.customer_group_for_sale(uuid) to authenticated;
grant execute on function public.resolve_sale_item_pricing(uuid, text, numeric, uuid, timestamptz) to authenticated;

grant select on public.customer_groups to authenticated;
grant select on public.product_customer_group_prices to authenticated;
grant select on public.product_presentation_prices to authenticated;
grant select on public.product_wholesale_tiers to authenticated;
grant select on public.product_promotions to authenticated;

alter table public.customer_groups enable row level security;
drop policy if exists "customer_groups_select_auth" on public.customer_groups;
create policy "customer_groups_select_auth" on public.customer_groups
  for select using (auth.uid() is not null);
drop policy if exists "customer_groups_insert_owner" on public.customer_groups;
create policy "customer_groups_insert_owner" on public.customer_groups
  for insert with check (public.is_owner());
drop policy if exists "customer_groups_update_owner" on public.customer_groups;
create policy "customer_groups_update_owner" on public.customer_groups
  for update using (public.is_owner())
  with check (public.is_owner());
drop policy if exists "customer_groups_delete_owner" on public.customer_groups;
create policy "customer_groups_delete_owner" on public.customer_groups
  for delete using (public.is_owner());

alter table public.product_customer_group_prices enable row level security;
drop policy if exists "product_customer_group_prices_select_auth" on public.product_customer_group_prices;
create policy "product_customer_group_prices_select_auth" on public.product_customer_group_prices
  for select using (auth.uid() is not null);
drop policy if exists "product_customer_group_prices_owner" on public.product_customer_group_prices;
create policy "product_customer_group_prices_owner" on public.product_customer_group_prices
  for all using (public.is_owner())
  with check (public.is_owner());

alter table public.product_presentation_prices enable row level security;
drop policy if exists "product_presentation_prices_select_auth" on public.product_presentation_prices;
create policy "product_presentation_prices_select_auth" on public.product_presentation_prices
  for select using (auth.uid() is not null);
drop policy if exists "product_presentation_prices_owner" on public.product_presentation_prices;
create policy "product_presentation_prices_owner" on public.product_presentation_prices
  for all using (public.is_owner())
  with check (public.is_owner());

alter table public.product_wholesale_tiers enable row level security;
drop policy if exists "product_wholesale_tiers_select_auth" on public.product_wholesale_tiers;
create policy "product_wholesale_tiers_select_auth" on public.product_wholesale_tiers
  for select using (auth.uid() is not null);
drop policy if exists "product_wholesale_tiers_owner" on public.product_wholesale_tiers;
create policy "product_wholesale_tiers_owner" on public.product_wholesale_tiers
  for all using (public.is_owner())
  with check (public.is_owner());

alter table public.product_promotions enable row level security;
drop policy if exists "product_promotions_select_auth" on public.product_promotions;
create policy "product_promotions_select_auth" on public.product_promotions
  for select using (auth.uid() is not null);
drop policy if exists "product_promotions_owner" on public.product_promotions;
create policy "product_promotions_owner" on public.product_promotions
  for all using (public.is_owner())
  with check (public.is_owner());
