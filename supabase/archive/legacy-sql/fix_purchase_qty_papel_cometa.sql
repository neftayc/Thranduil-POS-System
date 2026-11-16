-- Corrige la compra importada de Papel Cometa:
-- Debe ser 1 Ciento (no 100 Ciento).
--
-- SKU: SKU-9FCECC1704
-- Compra: IMPORT-HOJA1-EMPRESA-AYRAMPO-001

begin;

with target as (
  select
    pi.id,
    pi.purchase_id,
    pi.product_id,
    coalesce(pi.total_cost, 0)::numeric as total_cost,
    case
      when coalesce(pi.factor_to_base, 0) > 0 then pi.factor_to_base
      when coalesce(puc.factor_to_base, 0) > 0 then puc.factor_to_base
      else 1::numeric
    end as factor_to_base_effective
  from public.purchase_items pi
  join public.purchases pu on pu.id = pi.purchase_id
  join public.products pr on pr.id = pi.product_id
  left join public.product_unit_conversions puc
    on puc.product_id = pi.product_id
   and lower(coalesce(puc.unit_name, '')) = lower(coalesce(pi.unit_name, ''))
   and puc.is_active = true
  where pu.invoice_no = 'IMPORT-HOJA1-EMPRESA-AYRAMPO-001'
    and pr.sku = 'SKU-9FCECC1704'
  for update
),
updated_items as (
  update public.purchase_items pi
  set
    qty_uom = 1::numeric,
    qty = round((1::numeric * t.factor_to_base_effective)::numeric, 3),
    cost_unit_uom = round(t.total_cost::numeric, 4),
    cost_unit = case
      when t.factor_to_base_effective > 0
        then round((t.total_cost / t.factor_to_base_effective)::numeric, 4)
      else pi.cost_unit
    end
  from target t
  where pi.id = t.id
  returning
    pi.id,
    pi.purchase_id,
    pi.product_id,
    pi.unit_name,
    pi.qty_uom,
    pi.factor_to_base,
    pi.qty,
    pi.cost_unit_uom,
    pi.cost_unit,
    pi.total_cost
),
updated_movements as (
  update public.stock_movements sm
  set
    qty = ui.qty,
    cost_unit = ui.cost_unit
  from updated_items ui
  where sm.ref_table = 'purchases'
    and sm.ref_id = ui.purchase_id
    and sm.product_id = ui.product_id
  returning sm.id
)
select
  (select count(*) from updated_items) as purchase_items_updated,
  (select count(*) from updated_movements) as stock_movements_updated;

commit;

-- Si usas capas FIFO (stock_cost_layers), ejecuta luego:
-- /Users/rusbel/Develop/papeleria/supabase/rebuild_fifo_from_base_units.sql
