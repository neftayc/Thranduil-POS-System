begin;

create table if not exists public.stock_cost_layers (
  id uuid primary key default gen_random_uuid(),
  fifo_order bigint generated always as identity,
  product_id uuid not null references public.products on delete cascade,
  purchase_id uuid references public.purchases on delete set null,
  purchase_item_id uuid unique references public.purchase_items on delete set null,
  source text not null default 'purchase',
  layer_date timestamptz not null default now(),
  qty_in numeric(12,3) not null check (qty_in >= 0),
  qty_remaining numeric(12,3) not null check (qty_remaining >= 0),
  cost_unit numeric(12,4) not null check (cost_unit >= 0),
  note text,
  created_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sale_cost_allocations (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales on delete cascade,
  sale_item_id uuid not null references public.sale_items on delete cascade,
  product_id uuid not null references public.products on delete cascade,
  layer_id uuid not null references public.stock_cost_layers on delete restrict,
  qty numeric(12,3) not null check (qty > 0),
  cost_unit numeric(12,4) not null check (cost_unit >= 0),
  total_cost numeric(12,4) not null default 0,
  created_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_stock_cost_layers_product_fifo on public.stock_cost_layers (product_id, layer_date, fifo_order);
create index if not exists idx_stock_cost_layers_purchase on public.stock_cost_layers (purchase_id);
create index if not exists idx_sale_cost_allocations_sale on public.sale_cost_allocations (sale_id);
create index if not exists idx_sale_cost_allocations_sale_item on public.sale_cost_allocations (sale_item_id);

alter table public.stock_cost_layers enable row level security;
drop policy if exists "stock_cost_layers_all_auth" on public.stock_cost_layers;
create policy "stock_cost_layers_all_auth" on public.stock_cost_layers
  for all using (auth.uid() is not null)
  with check (auth.uid() is not null);

alter table public.sale_cost_allocations enable row level security;
drop policy if exists "sale_cost_allocations_all_auth" on public.sale_cost_allocations;
create policy "sale_cost_allocations_all_auth" on public.sale_cost_allocations
  for all using (auth.uid() is not null)
  with check (auth.uid() is not null);

create or replace view public.product_catalog
with (security_invoker = true)
as
select
  p.id,
  p.sku,
  p.name,
  p.description,
  p.brand,
  p.product_type,
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
  coalesce(fifo.fifo_next_cost, 0) as fifo_next_cost
from public.products p
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
     and lower(puc.unit_name) = lower(coalesce(public.resolve_uom_code(pi.unit_name), public.normalize_uom_code(pi.unit_name), 'unidad'))
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
      qty_base_recorded,
      case
        when unit_code = base_unit_code then 1::numeric
        when factor_catalog > 0 then factor_catalog
        when factor_item > 0 then factor_item
        else 1::numeric
      end as factor_effective,
      (
        unit_code <> base_unit_code
        and coalesce(factor_catalog, 0) <= 0
        and coalesce(factor_item, 1) = 1
        and coalesce(qty_base_recorded, 0) > 0
        and coalesce(qty_uom_recorded, 0) > 0
        and abs(coalesce(qty_base_recorded, 0) - coalesce(qty_uom_recorded, 0)) > 0.0005
      ) as is_legacy_without_conversion
    from pi_norm
  ),
  pi_metrics as (
    select
      id,
      total_cost,
      purchase_dt,
      item_dt,
      case
        when is_legacy_without_conversion then qty_base_recorded
        when qty_uom_recorded > 0 and factor_effective > 0 then qty_uom_recorded * factor_effective
        when qty_base_recorded > 0 then qty_base_recorded
        else 0
      end as qty_base_effective,
      case
        when (
          case
            when is_legacy_without_conversion then qty_base_recorded
            when qty_uom_recorded > 0 and factor_effective > 0 then qty_uom_recorded * factor_effective
            when qty_base_recorded > 0 then qty_base_recorded
            else 0
          end
        ) > 0 then round((
          total_cost / (
            case
              when is_legacy_without_conversion then qty_base_recorded
              when qty_uom_recorded > 0 and factor_effective > 0 then qty_uom_recorded * factor_effective
              when qty_base_recorded > 0 then qty_base_recorded
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
  with layer_base as (
    select
      scl.id,
      scl.source,
      coalesce(scl.layer_date, now()) as layer_date,
      scl.fifo_order,
      coalesce(scl.qty_remaining, 0)::numeric as qty_remaining_raw,
      coalesce(scl.cost_unit, 0)::numeric as cost_unit_raw,
      coalesce(pi.total_cost, 0)::numeric as item_total_cost,
      coalesce(pi.qty, 0)::numeric as item_qty_base_recorded,
      coalesce(pi.qty_uom, 0)::numeric as item_qty_uom_recorded,
      coalesce(pi.factor_to_base, 0)::numeric as item_factor_recorded,
      coalesce(puc.factor_to_base, 0)::numeric as factor_catalog,
      coalesce(public.resolve_uom_code(pi.unit_name), public.normalize_uom_code(pi.unit_name), 'unidad') as unit_code,
      coalesce(public.resolve_uom_code(p.unit), public.normalize_uom_code(p.unit), 'unidad') as base_unit_code
    from public.stock_cost_layers scl
    left join public.purchase_items pi on pi.id = scl.purchase_item_id
    left join public.product_unit_conversions puc
      on puc.product_id = scl.product_id
     and lower(puc.unit_name) = lower(coalesce(public.resolve_uom_code(pi.unit_name), public.normalize_uom_code(pi.unit_name), 'unidad'))
     and puc.is_active = true
    where scl.product_id = p.id
      and scl.qty_remaining > 0
  ),
  layer_norm as (
    select
      lb.*,
      case
        when lb.unit_code = lb.base_unit_code then 1::numeric
        when lb.factor_catalog > 0 then lb.factor_catalog
        when lb.item_factor_recorded > 0 then lb.item_factor_recorded
        else 1::numeric
      end as factor_effective,
      (
        lb.source = 'purchase'
        and lb.unit_code <> lb.base_unit_code
        and coalesce(lb.factor_catalog, 0) <= 0
        and coalesce(lb.item_factor_recorded, 1) = 1
        and coalesce(lb.item_qty_base_recorded, 0) > 0
        and coalesce(lb.item_qty_uom_recorded, 0) > 0
        and abs(coalesce(lb.item_qty_base_recorded, 0) - coalesce(lb.item_qty_uom_recorded, 0)) > 0.0005
      ) as is_legacy_without_conversion
    from layer_base lb
  ),
  layer_metrics as (
    select
      ln.source,
      case
        when ln.source = 'purchase' then
          ln.qty_remaining_raw * (
            case
              when ln.item_qty_base_recorded > 0 then
                (
                  case
                    when ln.is_legacy_without_conversion then ln.item_qty_base_recorded
                    when ln.item_qty_uom_recorded > 0 and ln.factor_effective > 0 then ln.item_qty_uom_recorded * ln.factor_effective
                    when ln.item_qty_base_recorded > 0 then ln.item_qty_base_recorded
                    else ln.item_qty_base_recorded
                  end
                ) / ln.item_qty_base_recorded
              else 1
            end
          )
        else ln.qty_remaining_raw
      end as qty_remaining_effective,
      ln.layer_date,
      ln.fifo_order,
      case
        when ln.source = 'purchase' then
          case
            when (
              case
                when ln.is_legacy_without_conversion then ln.item_qty_base_recorded
                when ln.item_qty_uom_recorded > 0 and ln.factor_effective > 0 then ln.item_qty_uom_recorded * ln.factor_effective
                when ln.item_qty_base_recorded > 0 then ln.item_qty_base_recorded
                else 0
              end
            ) > 0 then round((
              ln.item_total_cost / (
                case
                  when ln.is_legacy_without_conversion then ln.item_qty_base_recorded
                  when ln.item_qty_uom_recorded > 0 and ln.factor_effective > 0 then ln.item_qty_uom_recorded * ln.factor_effective
                  when ln.item_qty_base_recorded > 0 then ln.item_qty_base_recorded
                  else 1
                end
              )
            )::numeric, 4)
            else ln.cost_unit_raw
          end
        else
          case
            when ln.source in ('reconcile', 'auto-balance') and coalesce(pcost.avg_purchase_cost, 0) > 0
              then pcost.avg_purchase_cost
            else ln.cost_unit_raw
          end
      end as cost_unit_effective
    from layer_norm ln
  )
  select
    coalesce(sum(lm.qty_remaining_effective), 0)::numeric(12,3) as fifo_stock_qty,
    coalesce(sum(lm.qty_remaining_effective * lm.cost_unit_effective), 0)::numeric(14,4) as fifo_stock_value,
    coalesce(
      (
        select lm2.cost_unit_effective
        from layer_metrics lm2
        where lm2.qty_remaining_effective > 0
          and lm2.source = 'purchase'
        order by lm2.layer_date asc, lm2.fifo_order asc
        limit 1
      ),
      (
        select lm2.cost_unit_effective
        from layer_metrics lm2
        where lm2.qty_remaining_effective > 0
        order by lm2.layer_date asc, lm2.fifo_order asc
        limit 1
      )
    )::numeric(12,4) as fifo_next_cost
  from layer_metrics lm
) fifo on true
left join public.inventory_balances inv on inv.product_id = p.id;

create or replace function public.create_purchase(
  p_supplier_id uuid,
  p_invoice_no text,
  p_items jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_purchase_id uuid;
  v_purchase_item_id uuid;
  v_item jsonb;
  v_product_id uuid;
  v_qty_input numeric;
  v_cost_input numeric;
  v_qty_base numeric;
  v_cost_base numeric;
  v_unit_name text;
  v_base_unit text;
  v_factor numeric;
  v_old_stock numeric;
  v_old_avg numeric;
  v_min_stock numeric;
  v_new_stock numeric;
  v_new_avg numeric;
  v_total numeric := 0;
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'Items invalidos';
  end if;

  insert into public.purchases (supplier_id, invoice_no, created_by, total_cost)
  values (p_supplier_id, p_invoice_no, auth.uid(), 0)
  returning id into v_purchase_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_product_id := (v_item->>'product_id')::uuid;
    v_qty_input := coalesce(nullif(v_item->>'qty', '')::numeric, 0);
    v_cost_input := coalesce(nullif(v_item->>'cost_unit', '')::numeric, 0);

    if v_qty_input <= 0 then
      raise exception 'Cantidad invalida';
    end if;

    if v_cost_input < 0 then
      raise exception 'Costo invalido';
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
    v_factor := public.resolve_product_uom_factor(v_product_id, v_unit_name);
    v_qty_base := v_qty_input * v_factor;

    if v_qty_base <= 0 then
      raise exception 'Cantidad base invalida';
    end if;

    v_cost_base := v_cost_input / v_factor;

    insert into public.inventory_balances (product_id, stock_on_hand, avg_cost, min_stock, updated_at)
    values (
      v_product_id,
      0,
      0,
      coalesce((select p.min_stock from public.products p where p.id = v_product_id), 0),
      now()
    )
    on conflict (product_id) do nothing;

    select stock_on_hand, avg_cost, min_stock
      into v_old_stock, v_old_avg, v_min_stock
      from public.inventory_balances
      where product_id = v_product_id
      for update;

    v_new_stock := v_old_stock + v_qty_base;
    if v_new_stock = 0 then
      v_new_avg := 0;
    else
      v_new_avg := ((v_old_stock * v_old_avg) + (v_qty_base * v_cost_base)) / v_new_stock;
    end if;

    update public.inventory_balances
      set stock_on_hand = v_new_stock,
          avg_cost = v_new_avg,
          updated_at = now()
      where product_id = v_product_id;

    update public.products
      set stock_on_hand = v_new_stock,
          avg_cost = v_new_avg,
          min_stock = coalesce(v_min_stock, min_stock),
          updated_at = now()
      where id = v_product_id;

    insert into public.purchase_items (
      purchase_id,
      product_id,
      unit_name,
      qty_uom,
      factor_to_base,
      cost_unit_uom,
      qty,
      cost_unit,
      total_cost
    )
    values (
      v_purchase_id,
      v_product_id,
      v_unit_name,
      v_qty_input,
      v_factor,
      v_cost_input,
      v_qty_base,
      v_cost_base,
      v_qty_input * v_cost_input
    )
    returning id into v_purchase_item_id;

    insert into public.stock_cost_layers (
      product_id,
      purchase_id,
      purchase_item_id,
      source,
      layer_date,
      qty_in,
      qty_remaining,
      cost_unit,
      created_by
    )
    values (
      v_product_id,
      v_purchase_id,
      v_purchase_item_id,
      'purchase',
      coalesce((select p.purchase_date from public.purchases p where p.id = v_purchase_id), now()),
      v_qty_base,
      v_qty_base,
      v_cost_base,
      auth.uid()
    );

    insert into public.stock_movements (product_id, movement_type, qty, cost_unit, ref_table, ref_id, created_by)
    values (v_product_id, 'purchase', v_qty_base, v_cost_base, 'purchases', v_purchase_id, auth.uid());

    v_total := v_total + (v_qty_input * v_cost_input);
  end loop;

  update public.purchases
    set total_cost = v_total
    where id = v_purchase_id;

  return v_purchase_id;
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
  v_sale_item_id uuid;
  v_fifo_remaining numeric;
  v_fifo_take numeric;
  v_fifo_cost_total numeric;
  v_sale_cost_unit numeric;
  v_layer record;
  v_layer_fallback_id uuid;
  v_alloc jsonb;
  v_alloc_item jsonb;
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

    v_fifo_remaining := v_qty_base;
    v_fifo_cost_total := 0;
    v_alloc := '[]'::jsonb;

    for v_layer in
      select
        scl.id,
        scl.qty_remaining,
        scl.cost_unit
      from public.stock_cost_layers scl
      where scl.product_id = v_product_id
        and scl.qty_remaining > 0
      order by scl.layer_date asc, scl.fifo_order asc
      for update
    loop
      exit when v_fifo_remaining <= 0;

      v_fifo_take := least(v_fifo_remaining, v_layer.qty_remaining);
      if v_fifo_take <= 0 then
        continue;
      end if;

      update public.stock_cost_layers
      set qty_remaining = qty_remaining - v_fifo_take,
          updated_at = now()
      where id = v_layer.id;

      v_fifo_cost_total := v_fifo_cost_total + (v_fifo_take * v_layer.cost_unit);
      v_fifo_remaining := v_fifo_remaining - v_fifo_take;

      v_alloc := v_alloc || jsonb_build_array(
        jsonb_build_object(
          'layer_id', v_layer.id,
          'qty', v_fifo_take,
          'cost_unit', v_layer.cost_unit
        )
      );
    end loop;

    if v_fifo_remaining > 0 then
      insert into public.stock_cost_layers (
        product_id,
        source,
        layer_date,
        qty_in,
        qty_remaining,
        cost_unit,
        note,
        created_by,
        updated_at
      )
      values (
        v_product_id,
        'auto-balance',
        now(),
        v_fifo_remaining,
        0,
        coalesce(v_old_avg, 0),
        'Capa automatica para cuadrar venta sin capas FIFO previas',
        auth.uid(),
        now()
      )
      returning id into v_layer_fallback_id;

      v_fifo_cost_total := v_fifo_cost_total + (v_fifo_remaining * coalesce(v_old_avg, 0));
      v_alloc := v_alloc || jsonb_build_array(
        jsonb_build_object(
          'layer_id', v_layer_fallback_id,
          'qty', v_fifo_remaining,
          'cost_unit', coalesce(v_old_avg, 0)
        )
      );
      v_fifo_remaining := 0;
    end if;

    v_sale_cost_unit := case
      when v_qty_base > 0 then round((v_fifo_cost_total / v_qty_base)::numeric, 4)
      else coalesce(v_old_avg, 0)
    end;

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
    )
    returning id into v_sale_item_id;

    for v_alloc_item in
      select * from jsonb_array_elements(v_alloc)
    loop
      insert into public.sale_cost_allocations (
        sale_id,
        sale_item_id,
        product_id,
        layer_id,
        qty,
        cost_unit,
        total_cost,
        created_by
      )
      values (
        v_sale_id,
        v_sale_item_id,
        v_product_id,
        (v_alloc_item->>'layer_id')::uuid,
        coalesce((v_alloc_item->>'qty')::numeric, 0),
        coalesce((v_alloc_item->>'cost_unit')::numeric, 0),
        coalesce((v_alloc_item->>'qty')::numeric, 0) * coalesce((v_alloc_item->>'cost_unit')::numeric, 0),
        auth.uid()
      );
    end loop;

    insert into public.stock_movements (product_id, movement_type, qty, cost_unit, ref_table, ref_id, created_by)
    values (v_product_id, 'sale', -v_qty_base, v_sale_cost_unit, 'sales', v_sale_id, auth.uid());

    v_total := v_total + (v_qty_input * v_final_price_uom);
  end loop;

  update public.sales
    set total = v_total
    where id = v_sale_id;

  return v_sale_id;
end;
$$;

grant execute on function public.create_purchase(uuid, text, jsonb) to authenticated;
grant execute on function public.create_sale(uuid, text, jsonb) to authenticated;

do $$
declare
  v_sale_item record;
  v_stock_row record;
  v_layer record;
  v_remaining numeric;
  v_take numeric;
  v_layer_id uuid;
  v_layer_qty numeric;
  v_diff numeric;
  v_ref_cost numeric;
begin
  truncate table public.sale_cost_allocations;
  delete from public.stock_cost_layers;

  insert into public.stock_cost_layers (
    product_id,
    purchase_id,
    purchase_item_id,
    source,
    layer_date,
    qty_in,
    qty_remaining,
    cost_unit,
    created_by,
    created_at,
    updated_at
  )
  select
    pi.product_id,
    pi.purchase_id,
    pi.id,
    'purchase',
    coalesce(p.purchase_date, p.created_at, pi.created_at, now()),
    coalesce(pi.qty, 0),
    coalesce(pi.qty, 0),
    coalesce(pi.cost_unit, 0),
    p.created_by,
    coalesce(pi.created_at, p.created_at, now()),
    now()
  from public.purchase_items pi
  join public.purchases p on p.id = pi.purchase_id
  where coalesce(pi.qty, 0) > 0
  order by
    case when p.invoice_no = 'IMPORT-HOJA1-TANIA-YUCRA-001' then 0 else 1 end,
    coalesce(p.purchase_date, p.created_at, pi.created_at, now()),
    coalesce(p.created_at, pi.created_at, now()),
    p.id,
    pi.id;

  for v_sale_item in
    select
      si.id as sale_item_id,
      si.sale_id,
      si.product_id,
      coalesce(si.qty, 0) as qty,
      coalesce(s.sale_date, s.created_at, si.created_at, now()) as sale_dt
    from public.sale_items si
    join public.sales s on s.id = si.sale_id
    where coalesce(si.qty, 0) > 0
    order by coalesce(s.sale_date, s.created_at, si.created_at, now()), s.id, si.id
  loop
    v_remaining := v_sale_item.qty;

    for v_layer in
      select id, qty_remaining, cost_unit
      from public.stock_cost_layers
      where product_id = v_sale_item.product_id
        and qty_remaining > 0
      order by layer_date asc, fifo_order asc
      for update
    loop
      exit when v_remaining <= 0;

      v_take := least(v_remaining, v_layer.qty_remaining);
      if v_take <= 0 then
        continue;
      end if;

      update public.stock_cost_layers
      set qty_remaining = qty_remaining - v_take,
          updated_at = now()
      where id = v_layer.id;

      insert into public.sale_cost_allocations (
        sale_id,
        sale_item_id,
        product_id,
        layer_id,
        qty,
        cost_unit,
        total_cost,
        created_at
      )
      values (
        v_sale_item.sale_id,
        v_sale_item.sale_item_id,
        v_sale_item.product_id,
        v_layer.id,
        v_take,
        v_layer.cost_unit,
        v_take * v_layer.cost_unit,
        v_sale_item.sale_dt
      );

      v_remaining := v_remaining - v_take;
    end loop;

    if v_remaining > 0 then
      select sm.cost_unit
        into v_ref_cost
      from public.stock_movements sm
      where sm.ref_table = 'sales'
        and sm.ref_id = v_sale_item.sale_id
        and sm.product_id = v_sale_item.product_id
      order by sm.created_at
      limit 1;

      v_ref_cost := coalesce(
        v_ref_cost,
        (select ib.avg_cost from public.inventory_balances ib where ib.product_id = v_sale_item.product_id),
        0
      );

      insert into public.stock_cost_layers (
        product_id,
        source,
        layer_date,
        qty_in,
        qty_remaining,
        cost_unit,
        note,
        created_at,
        updated_at
      )
      values (
        v_sale_item.product_id,
        'auto-balance',
        v_sale_item.sale_dt,
        v_remaining,
        0,
        v_ref_cost,
        'Backfill historico: capa sintetica por faltante de historial de compras',
        v_sale_item.sale_dt,
        now()
      )
      returning id into v_layer_id;

      insert into public.sale_cost_allocations (
        sale_id,
        sale_item_id,
        product_id,
        layer_id,
        qty,
        cost_unit,
        total_cost,
        created_at
      )
      values (
        v_sale_item.sale_id,
        v_sale_item.sale_item_id,
        v_sale_item.product_id,
        v_layer_id,
        v_remaining,
        v_ref_cost,
        v_remaining * v_ref_cost,
        v_sale_item.sale_dt
      );

      v_remaining := 0;
    end if;
  end loop;

  for v_stock_row in
    select
      ib.product_id,
      coalesce(ib.stock_on_hand, 0) as stock_on_hand,
      coalesce(ib.avg_cost, 0) as avg_cost
    from public.inventory_balances ib
  loop
    select coalesce(sum(scl.qty_remaining), 0)
      into v_layer_qty
    from public.stock_cost_layers scl
    where scl.product_id = v_stock_row.product_id;

    v_diff := v_stock_row.stock_on_hand - v_layer_qty;

    if v_diff > 0 then
      insert into public.stock_cost_layers (
        product_id,
        source,
        layer_date,
        qty_in,
        qty_remaining,
        cost_unit,
        note,
        updated_at
      )
      values (
        v_stock_row.product_id,
        'reconcile',
        now(),
        v_diff,
        v_diff,
        v_stock_row.avg_cost,
        'Backfill: ajuste para cuadrar capas FIFO con stock actual',
        now()
      );
    elsif v_diff < 0 then
      v_remaining := abs(v_diff);

      for v_layer in
        select id, qty_remaining
        from public.stock_cost_layers
        where product_id = v_stock_row.product_id
          and qty_remaining > 0
        order by layer_date desc, fifo_order desc
        for update
      loop
        exit when v_remaining <= 0;

        v_take := least(v_remaining, v_layer.qty_remaining);
        if v_take <= 0 then
          continue;
        end if;

        update public.stock_cost_layers
        set qty_remaining = qty_remaining - v_take,
            updated_at = now()
        where id = v_layer.id;

        v_remaining := v_remaining - v_take;
      end loop;
    end if;
  end loop;
end $$;

commit;
