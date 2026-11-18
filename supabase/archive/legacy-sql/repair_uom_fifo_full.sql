-- Reparación histórica de unidades de compra + FIFO.
--
-- Corrige datos derivados por purchase_items con factor_to_base antiguo:
--   1) Normaliza purchase_items a unidad base usando product_unit_conversions.
--   2) Actualiza avg_cost en inventory_balances/products según compras normalizadas.
--   3) Reconstruye stock_cost_layers.
--   4) Reconstruye sale_cost_allocations.
--   5) Actualiza cost_unit de stock_movements de venta desde las asignaciones FIFO.
--
-- Ejecutar en Supabase SQL Editor. Todo corre dentro de una transacción.

begin;

lock table public.purchase_items in share row exclusive mode;
lock table public.sale_items in share row exclusive mode;
lock table public.purchases in share row exclusive mode;
lock table public.sales in share row exclusive mode;
lock table public.products in share row exclusive mode;
lock table public.inventory_balances in share row exclusive mode;
lock table public.stock_movements in share row exclusive mode;
lock table public.stock_cost_layers in share row exclusive mode;
lock table public.sale_cost_allocations in share row exclusive mode;

create temporary table tmp_purchase_items_before on commit drop as
select
  pi.id,
  pi.factor_to_base,
  pi.qty_uom,
  pi.cost_unit_uom,
  pi.qty,
  pi.cost_unit,
  pi.total_cost
from public.purchase_items pi;

create temporary table tmp_purchase_calc on commit drop as
with base as (
  select
    pi.id,
    pi.product_id,
    coalesce(public.resolve_uom_code(pi.unit_name), public.normalize_uom_code(pi.unit_name), 'unidad') as unit_code,
    coalesce(public.resolve_uom_code(pr.unit), public.normalize_uom_code(pr.unit), 'unidad') as base_unit_code,
    coalesce(puc.factor_to_base, 0)::numeric as factor_catalog,
    coalesce(pi.factor_to_base, 0)::numeric as factor_item,
    coalesce(pi.qty_uom, 0)::numeric as qty_uom_raw,
    coalesce(pi.qty, 0)::numeric as qty_base_raw,
    coalesce(pi.cost_unit_uom, 0)::numeric as cost_uom_raw,
    coalesce(pi.cost_unit, 0)::numeric as cost_base_raw,
    coalesce(pi.total_cost, 0)::numeric as total_cost
  from public.purchase_items pi
  join public.products pr on pr.id = pi.product_id
  left join public.product_unit_conversions puc
    on puc.product_id = pi.product_id
   and coalesce(public.resolve_uom_code(puc.unit_name), public.normalize_uom_code(puc.unit_name), 'unidad')
       = coalesce(public.resolve_uom_code(pi.unit_name), public.normalize_uom_code(pi.unit_name), 'unidad')
   and puc.is_active = true
),
calc as (
  select
    b.*,
    case
      when b.unit_code = b.base_unit_code then 1::numeric
      when b.factor_catalog > 0 then b.factor_catalog
      when b.factor_item > 0 then b.factor_item
      else 1::numeric
    end as factor_effective
  from base b
)
select
  c.id,
  c.product_id,
  c.unit_code,
  round(c.factor_effective::numeric, 6) as factor_effective,
  round((
    case
      when c.qty_uom_raw > 0 then c.qty_uom_raw
      when c.qty_base_raw > 0 and c.factor_effective > 0 then c.qty_base_raw / c.factor_effective
      else 0::numeric
    end
  )::numeric, 3) as qty_uom_effective,
  round((
    case
      when c.cost_uom_raw > 0 then c.cost_uom_raw
      when c.qty_uom_raw > 0 then c.total_cost / c.qty_uom_raw
      when c.cost_base_raw > 0 then c.cost_base_raw * c.factor_effective
      else 0::numeric
    end
  )::numeric, 4) as cost_uom_effective,
  round((
    case
      when c.qty_uom_raw > 0 then c.qty_uom_raw
      when c.qty_base_raw > 0 and c.factor_effective > 0 then c.qty_base_raw / c.factor_effective
      else 0::numeric
    end
    * c.factor_effective
  )::numeric, 3) as qty_base_effective,
  case
    when (
      case
        when c.qty_uom_raw > 0 then c.qty_uom_raw
        when c.qty_base_raw > 0 and c.factor_effective > 0 then c.qty_base_raw / c.factor_effective
        else 0::numeric
      end
      * c.factor_effective
    ) > 0
      then round((c.total_cost / (
        case
          when c.qty_uom_raw > 0 then c.qty_uom_raw
          when c.qty_base_raw > 0 and c.factor_effective > 0 then c.qty_base_raw / c.factor_effective
          else 0::numeric
        end
        * c.factor_effective
      ))::numeric, 4)
    else 0::numeric
  end as cost_base_effective
from calc c;

update public.purchase_items pi
set
  unit_name = c.unit_code,
  factor_to_base = c.factor_effective,
  qty_uom = c.qty_uom_effective,
  cost_unit_uom = c.cost_uom_effective,
  qty = c.qty_base_effective,
  cost_unit = c.cost_base_effective
from tmp_purchase_calc c
where pi.id = c.id
  and c.qty_uom_effective > 0;

do $$
declare
  v_changed_totals int := 0;
begin
  select count(*)
    into v_changed_totals
  from public.purchase_items pi
  join tmp_purchase_items_before b on b.id = pi.id
  where pi.total_cost is distinct from b.total_cost;

  if v_changed_totals > 0 then
    raise exception 'Abortado: % purchase_items alteraron total_cost', v_changed_totals;
  end if;
end $$;

create temporary table tmp_product_avg_cost on commit drop as
select
  pi.product_id,
  round((sum(coalesce(pi.total_cost, 0)) / nullif(sum(coalesce(pi.qty, 0)), 0))::numeric, 4) as avg_cost
from public.purchase_items pi
group by pi.product_id
having sum(coalesce(pi.qty, 0)) > 0;

update public.inventory_balances ib
set
  avg_cost = c.avg_cost,
  updated_at = now()
from tmp_product_avg_cost c
where c.product_id = ib.product_id
  and abs(coalesce(ib.avg_cost, 0) - c.avg_cost) > 0.00005;

update public.products p
set
  avg_cost = c.avg_cost,
  updated_at = now()
from tmp_product_avg_cost c
where c.product_id = p.id
  and abs(coalesce(p.avg_cost, 0) - c.avg_cost) > 0.00005;

truncate table public.sale_cost_allocations, public.stock_cost_layers restart identity;

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
order by coalesce(p.purchase_date, p.created_at, pi.created_at, now()), coalesce(pi.created_at, p.created_at, now()), p.id, pi.id;

do $$
declare
  v_sale_item record;
  v_layer record;
  v_stock_row record;
  v_remaining numeric;
  v_take numeric;
  v_layer_id uuid;
  v_layer_qty numeric;
  v_diff numeric;
  v_ref_cost numeric;
  v_bad_alloc int := 0;
  v_bad_stock int := 0;
begin
  for v_sale_item in
    with sales_effective as (
      select
        si.id as sale_item_id,
        si.sale_id,
        si.product_id,
        coalesce(s.sale_date, s.created_at, si.created_at, now()) as sale_dt,
        coalesce(public.resolve_uom_code(si.unit_name), public.normalize_uom_code(si.unit_name), 'unidad') as unit_code,
        coalesce(public.resolve_uom_code(pr.unit), public.normalize_uom_code(pr.unit), 'unidad') as base_unit_code,
        coalesce(puc.factor_to_base, 0)::numeric as factor_catalog,
        coalesce(si.factor_to_base, 0)::numeric as factor_item,
        coalesce(si.qty_uom, 0)::numeric as qty_uom_raw,
        coalesce(si.qty, 0)::numeric as qty_base_raw
      from public.sale_items si
      join public.sales s on s.id = si.sale_id
      join public.products pr on pr.id = si.product_id
      left join public.product_unit_conversions puc
        on puc.product_id = si.product_id
       and coalesce(public.resolve_uom_code(puc.unit_name), public.normalize_uom_code(puc.unit_name), 'unidad')
           = coalesce(public.resolve_uom_code(si.unit_name), public.normalize_uom_code(si.unit_name), 'unidad')
       and puc.is_active = true
      where coalesce(si.qty, 0) > 0 or coalesce(si.qty_uom, 0) > 0
    ),
    sales_calc as (
      select
        se.*,
        case
          when se.unit_code = se.base_unit_code then 1::numeric
          when se.factor_catalog > 0 then se.factor_catalog
          when se.factor_item > 0 then se.factor_item
          else 1::numeric
        end as factor_effective
      from sales_effective se
    )
    select
      sc.sale_item_id,
      sc.sale_id,
      sc.product_id,
      round((
        case
          when sc.qty_uom_raw > 0 then sc.qty_uom_raw
          when sc.qty_base_raw > 0 and sc.factor_effective > 0 then sc.qty_base_raw / sc.factor_effective
          else 0::numeric
        end
        * sc.factor_effective
      )::numeric, 3) as qty,
      sc.sale_dt
    from sales_calc sc
    where (
      case
        when sc.qty_uom_raw > 0 then sc.qty_uom_raw
        when sc.qty_base_raw > 0 and sc.factor_effective > 0 then sc.qty_base_raw / sc.factor_effective
        else 0::numeric
      end
      * sc.factor_effective
    ) > 0
    order by sc.sale_dt, sc.sale_id, sc.sale_item_id
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
      select c.avg_cost
        into v_ref_cost
      from tmp_product_avg_cost c
      where c.product_id = v_sale_item.product_id;

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
        'Repair historico: capa sintetica por faltante de historial de compras',
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
      coalesce(c.avg_cost, ib.avg_cost, 0) as avg_cost
    from public.inventory_balances ib
    left join tmp_product_avg_cost c on c.product_id = ib.product_id
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
        'Repair: ajuste para cuadrar capas FIFO con stock actual',
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

  select count(*)
    into v_bad_alloc
  from (
    with sale_qty as (
      select
        si.id,
        round((
          case
            when coalesce(si.qty_uom, 0) > 0 then coalesce(si.qty_uom, 0)
            else coalesce(si.qty, 0)
          end
          *
          case
            when coalesce(public.resolve_uom_code(si.unit_name), public.normalize_uom_code(si.unit_name), 'unidad')
               = coalesce(public.resolve_uom_code(pr.unit), public.normalize_uom_code(pr.unit), 'unidad') then 1::numeric
            when coalesce(puc.factor_to_base, 0) > 0 then puc.factor_to_base
            when coalesce(si.factor_to_base, 0) > 0 then si.factor_to_base
            else 1::numeric
          end
        )::numeric, 3) as sale_qty
      from public.sale_items si
      join public.products pr on pr.id = si.product_id
      left join public.product_unit_conversions puc
        on puc.product_id = si.product_id
       and coalesce(public.resolve_uom_code(puc.unit_name), public.normalize_uom_code(puc.unit_name), 'unidad')
           = coalesce(public.resolve_uom_code(si.unit_name), public.normalize_uom_code(si.unit_name), 'unidad')
       and puc.is_active = true
    )
    select
      sq.id,
      sq.sale_qty,
      round(coalesce(sum(sca.qty), 0)::numeric, 3) as alloc_qty
    from sale_qty sq
    left join public.sale_cost_allocations sca on sca.sale_item_id = sq.id
    where sq.sale_qty > 0
    group by sq.id, sq.sale_qty
    having abs(sq.sale_qty - round(coalesce(sum(sca.qty), 0)::numeric, 3)) > 0.0005
  ) q;

  if v_bad_alloc > 0 then
    raise exception 'Repair incompleto: % sale_items sin asignacion FIFO completa', v_bad_alloc;
  end if;

  select count(*)
    into v_bad_stock
  from (
    select
      ib.product_id,
      round(coalesce(ib.stock_on_hand, 0)::numeric, 3) as stock_balance,
      round(coalesce(sum(scl.qty_remaining), 0)::numeric, 3) as stock_layers
    from public.inventory_balances ib
    left join public.stock_cost_layers scl on scl.product_id = ib.product_id
    group by ib.product_id, ib.stock_on_hand
    having abs(round(coalesce(ib.stock_on_hand, 0)::numeric, 3) - round(coalesce(sum(scl.qty_remaining), 0)::numeric, 3)) > 0.0005
  ) s;

  if v_bad_stock > 0 then
    raise exception 'Repair incompleto: % productos no cuadran stock vs capas FIFO', v_bad_stock;
  end if;
end $$;

with movement_costs as (
  select
    sale_id,
    product_id,
    round((sum(total_cost) / nullif(sum(qty), 0))::numeric, 4) as cost_unit
  from public.sale_cost_allocations
  group by sale_id, product_id
)
update public.stock_movements sm
set cost_unit = mc.cost_unit
from movement_costs mc
where sm.movement_type = 'sale'
  and sm.ref_table = 'sales'
  and sm.ref_id = mc.sale_id
  and sm.product_id = mc.product_id
  and abs(coalesce(sm.cost_unit, 0) - mc.cost_unit) > 0.00005;

commit;

select
  count(*) as purchase_items_total,
  count(*) filter (
    where abs(coalesce(pi.factor_to_base, 0) - coalesce(puc.factor_to_base, case when public.resolve_uom_code(pi.unit_name) = public.resolve_uom_code(pr.unit) then 1 else pi.factor_to_base end)) > 0.0005
  ) as purchase_items_still_mismatched
from public.purchase_items pi
join public.products pr on pr.id = pi.product_id
left join public.product_unit_conversions puc
  on puc.product_id = pi.product_id
 and coalesce(public.resolve_uom_code(puc.unit_name), public.normalize_uom_code(puc.unit_name), 'unidad')
     = coalesce(public.resolve_uom_code(pi.unit_name), public.normalize_uom_code(pi.unit_name), 'unidad')
 and puc.is_active = true;

select
  count(*) as layers_count,
  round(coalesce(sum(qty_remaining), 0)::numeric, 3) as layers_qty_remaining
from public.stock_cost_layers;

select
  count(*) as allocations_count,
  round(coalesce(sum(qty), 0)::numeric, 3) as allocations_qty,
  round(coalesce(sum(total_cost), 0)::numeric, 2) as allocations_total_cost
from public.sale_cost_allocations;
