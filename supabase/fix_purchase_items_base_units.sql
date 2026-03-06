-- Normaliza purchase_items para guardar qty/cost_unit en unidad base,
-- preservando total_cost registrado.
--
-- Regla:
-- - qty_uom y cost_unit_uom se mantienen como valores de la presentación comprada.
-- - qty y cost_unit se recalculan en unidad base.
-- - factor se toma de product_unit_conversions activo; si no existe, usa factor_to_base existente.
--
-- Ejecutar en Supabase SQL Editor dentro de una transacción.

begin;

create temporary table tmp_purchase_items_before on commit drop as
select
  pi.id,
  pi.total_cost
from public.purchase_items pi;

with base as (
  select
    pi.id,
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
   and lower(puc.unit_name) = lower(coalesce(public.resolve_uom_code(pi.unit_name), public.normalize_uom_code(pi.unit_name), 'unidad'))
   and puc.is_active = true
),
calc as (
  select
    b.id,
    b.unit_code,
    case
      when b.unit_code = b.base_unit_code then 1::numeric
      when b.factor_catalog > 0 then b.factor_catalog
      when b.factor_item > 0 then b.factor_item
      else 1::numeric
    end as factor_effective,
    case
      when b.qty_uom_raw > 0 then b.qty_uom_raw
      when b.qty_base_raw > 0 and (
        case
          when b.unit_code = b.base_unit_code then 1::numeric
          when b.factor_catalog > 0 then b.factor_catalog
          when b.factor_item > 0 then b.factor_item
          else 1::numeric
        end
      ) > 0 then b.qty_base_raw / (
        case
          when b.unit_code = b.base_unit_code then 1::numeric
          when b.factor_catalog > 0 then b.factor_catalog
          when b.factor_item > 0 then b.factor_item
          else 1::numeric
        end
      )
      else 0::numeric
    end as qty_uom_effective,
    case
      when b.cost_uom_raw > 0 then b.cost_uom_raw
      when b.qty_uom_raw > 0 then b.total_cost / b.qty_uom_raw
      when b.cost_base_raw > 0 then b.cost_base_raw * (
        case
          when b.unit_code = b.base_unit_code then 1::numeric
          when b.factor_catalog > 0 then b.factor_catalog
          when b.factor_item > 0 then b.factor_item
          else 1::numeric
        end
      )
      else 0::numeric
    end as cost_uom_effective
  from base b
)
update public.purchase_items pi
set
  unit_name = c.unit_code,
  factor_to_base = round(c.factor_effective::numeric, 6),
  qty_uom = round(c.qty_uom_effective::numeric, 3),
  cost_unit_uom = round(c.cost_uom_effective::numeric, 4),
  qty = round((c.qty_uom_effective * c.factor_effective)::numeric, 3),
  cost_unit = case
    when (c.qty_uom_effective * c.factor_effective) > 0
      then round((pi.total_cost / (c.qty_uom_effective * c.factor_effective))::numeric, 4)
    else 0
  end
from calc c
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
    raise exception 'Abortado: % items alteraron total_cost', v_changed_totals;
  end if;
end $$;

commit;

-- Verificación rápida
select
  count(*) as items_total,
  count(*) filter (where qty > 0) as items_qty_base_ok,
  count(*) filter (where factor_to_base > 0) as items_factor_ok
from public.purchase_items;
