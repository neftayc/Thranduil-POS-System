-- Rebuild completo de capas FIFO y asignaciones de costo de ventas
-- usando purchase_items ya normalizado a unidad base (qty/cost_unit).
--
-- No modifica totales de compras/ventas.
-- Recalcula:
--   - stock_cost_layers (capas de compra + auto-balance + reconciliación)
--   - sale_cost_allocations (consumo FIFO por sale_item)
--
-- Ejecutar en Supabase SQL Editor.

begin;

lock table public.purchase_items in share row exclusive mode;
lock table public.sale_items in share row exclusive mode;
lock table public.purchases in share row exclusive mode;
lock table public.sales in share row exclusive mode;
lock table public.inventory_balances in share row exclusive mode;
lock table public.stock_cost_layers in share row exclusive mode;
lock table public.sale_cost_allocations in share row exclusive mode;

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
  v_bad_alloc int := 0;
  v_bad_stock int := 0;
begin
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
  with purchase_effective as (
    select
      pi.id as purchase_item_id,
      pi.product_id,
      pi.purchase_id,
      coalesce(p.purchase_date, p.created_at, pi.created_at, now()) as layer_dt,
      p.created_by,
      coalesce(pi.created_at, p.created_at, now()) as created_dt,
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
    join public.purchases p on p.id = pi.purchase_id
    join public.products pr on pr.id = pi.product_id
    left join public.product_unit_conversions puc
      on puc.product_id = pi.product_id
     and coalesce(public.resolve_uom_code(puc.unit_name), public.normalize_uom_code(puc.unit_name), 'unidad')
         = coalesce(public.resolve_uom_code(pi.unit_name), public.normalize_uom_code(pi.unit_name), 'unidad')
     and puc.is_active = true
  ),
  purchase_calc as (
    select
      pe.*,
      case
        when pe.unit_code = pe.base_unit_code then 1::numeric
        when pe.factor_catalog > 0 then pe.factor_catalog
        when pe.factor_item > 0 then pe.factor_item
        else 1::numeric
      end as factor_effective,
      case
        when pe.qty_uom_raw > 0 then pe.qty_uom_raw
        when pe.qty_base_raw > 0 then pe.qty_base_raw
        else 0::numeric
      end as qty_uom_effective
    from purchase_effective pe
  )
  select
    pc.product_id,
    pc.purchase_id,
    pc.purchase_item_id,
    'purchase',
    pc.layer_dt,
    round((pc.qty_uom_effective * pc.factor_effective)::numeric, 3) as qty_in,
    round((pc.qty_uom_effective * pc.factor_effective)::numeric, 3) as qty_remaining,
    case
      when (pc.qty_uom_effective * pc.factor_effective) > 0
        then round((pc.total_cost / (pc.qty_uom_effective * pc.factor_effective))::numeric, 4)
      when pc.factor_effective > 0 and pc.cost_uom_raw > 0
        then round((pc.cost_uom_raw / pc.factor_effective)::numeric, 4)
      else round(pc.cost_base_raw::numeric, 4)
    end as cost_unit,
    pc.created_by,
    pc.created_dt,
    now()
  from purchase_calc pc
  where (pc.qty_uom_effective * pc.factor_effective) > 0
  order by pc.layer_dt, pc.created_dt, pc.purchase_id, pc.purchase_item_id;

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
    )
    select
      se.sale_item_id,
      se.sale_id,
      se.product_id,
      case
        when (
          case
            when se.unit_code = se.base_unit_code then 1::numeric
            when se.factor_catalog > 0 then se.factor_catalog
            when se.factor_item > 0 then se.factor_item
            else 1::numeric
          end
        ) > 0 then round((
          case
            when se.qty_uom_raw > 0 then se.qty_uom_raw
            when se.qty_base_raw > 0 then se.qty_base_raw
            else 0
          end
          *
          (
            case
              when se.unit_code = se.base_unit_code then 1::numeric
              when se.factor_catalog > 0 then se.factor_catalog
              when se.factor_item > 0 then se.factor_item
              else 1::numeric
            end
          )
        )::numeric, 3)
        else round(se.qty_base_raw::numeric, 3)
      end as qty,
      se.sale_dt
    from sales_effective se
    order by se.sale_dt, se.sale_id, se.sale_item_id
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
        'Rebuild historico: capa sintetica por faltante de historial de compras',
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

  -- Cuadrar capas FIFO contra stock actual en inventory_balances
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
        'Rebuild: ajuste para cuadrar capas FIFO con stock actual',
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

  -- Validación 1: cada sale_item debe quedar totalmente asignado
  select count(*)
    into v_bad_alloc
  from (
    select
      si.id,
      round(coalesce(si.qty, 0)::numeric, 3) as sale_qty,
      round(coalesce(sum(sca.qty), 0)::numeric, 3) as alloc_qty
    from public.sale_items si
    left join public.sale_cost_allocations sca on sca.sale_item_id = si.id
    where coalesce(si.qty, 0) > 0
    group by si.id, si.qty
    having abs(round(coalesce(si.qty, 0)::numeric, 3) - round(coalesce(sum(sca.qty), 0)::numeric, 3)) > 0.0005
  ) q;

  if v_bad_alloc > 0 then
    raise exception 'Rebuild incompleto: % sale_items sin asignacion FIFO completa', v_bad_alloc;
  end if;

  -- Validación 2: capas restantes deben cuadrar con inventory_balances
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
    raise exception 'Rebuild incompleto: % productos no cuadran stock vs capas FIFO', v_bad_stock;
  end if;
end
$$;

commit;

-- Verificación rápida post-rebuild
select
  count(*) as layers_count,
  round(coalesce(sum(qty_remaining), 0)::numeric, 3) as layers_qty_remaining
from public.stock_cost_layers;

select
  count(*) as allocations_count,
  round(coalesce(sum(qty), 0)::numeric, 3) as allocations_qty
from public.sale_cost_allocations;
