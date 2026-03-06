create or replace function public.normalize_uom_code(p_value text)
returns text
language sql
immutable
as $$
  select lower(trim(coalesce(p_value, '')));
$$;

create or replace function public.resolve_uom_code(p_value text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_input text;
  v_code text;
begin
  v_input := public.normalize_uom_code(p_value);
  if v_input = '' then
    return null;
  end if;

  select u.code
    into v_code
    from public.uom_catalog u
    where u.active = true
      and (
        u.code = v_input
        or public.normalize_uom_code(u.label) = v_input
        or public.normalize_uom_code(u.label || 's') = v_input
        or public.normalize_uom_code(u.code || 's') = v_input
      )
    limit 1;

  return v_code;
end;
$$;

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
  coalesce(fifo.fifo_next_cost, 0) as fifo_next_cost,
  coalesce(fifo.fifo_next_qty, 0) as fifo_next_qty,
  coalesce(uom.needs_presentation_setup, false) as needs_presentation_setup,
  coalesce(uom.missing_purchase_units, array[]::text[]) as missing_purchase_units
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

drop trigger if exists trg_purchase_items_sync_base_fields on public.purchase_items;
