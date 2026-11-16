-- Backfill de unidades para compra importada:
-- invoice_no = IMPORT-HOJA1-TANIA-YUCRA-001
--
-- Objetivo:
-- 1) Recuperar unidad desde stg_compras_tania_import
-- 2) Escribir unit_name/qty_uom/cost_unit_uom en purchase_items
-- 3) Mantener qty/cost_unit actuales (sin recalcular inventario histórico)
--
-- Ejecutar en Supabase SQL Editor dentro de una transacción.

begin;

-- 1) Asegurar unidades faltantes en catálogo global
insert into public.uom_catalog (code, label, active)
values
  ('ciento', 'Ciento', true),
  ('sobre', 'Sobre', true),
  ('par', 'Par', true)
on conflict (code) do update
set
  label = excluded.label,
  active = excluded.active;

-- Snapshot de seguridad: valores que NO deben cambiar
create temporary table tmp_tania_purchase_before on commit drop as
select
  pi.id,
  pi.purchase_id,
  pi.product_id,
  pi.qty,
  pi.cost_unit,
  pi.total_cost
from public.purchase_items pi
join public.purchases p on p.id = pi.purchase_id
where p.invoice_no = 'IMPORT-HOJA1-TANIA-YUCRA-001';

-- 2) Emparejar líneas importadas vs purchase_items de esa compra
-- Estrategia:
--   Fase 1: SKU + qty + total_cost
--   Fase 2: Nombre + qty + total_cost
--   Fase 3: Nombre (fallback)
create temporary table tmp_tania_stage_base on commit drop as
select
  row_number() over (order by trim(st.product_sku), trim(st.product_name), coalesce(st.qty, 0), coalesce(st.total_cost, 0)) as stage_row_id,
  lower(trim(coalesce(st.product_sku, ''))) as sku_key,
  lower(trim(coalesce(st.product_name, ''))) as name_key,
  st.qty::numeric as qty,
  coalesce(st.total_cost, 0)::numeric as total_cost,
  public.normalize_uom_code(st.unit) as unit_raw
from public.stg_compras_tania_import st
where coalesce(st.qty, 0) > 0;

create temporary table tmp_tania_purchase_base on commit drop as
select
  pi.id as purchase_item_id,
  lower(trim(coalesce(pr.sku, ''))) as sku_key,
  lower(trim(coalesce(pr.name, ''))) as name_key,
  pi.qty,
  pi.total_cost
from public.purchase_items pi
join public.purchases p on p.id = pi.purchase_id
join public.products pr on pr.id = pi.product_id
where p.invoice_no = 'IMPORT-HOJA1-TANIA-YUCRA-001';

create temporary table tmp_tania_match_phase1 on commit drop as
with s as (
  select
    sb.*,
    row_number() over (partition by sb.sku_key, sb.qty, sb.total_cost order by sb.stage_row_id) as rn
  from tmp_tania_stage_base sb
  where sb.sku_key <> ''
),
p as (
  select
    pb.*,
    row_number() over (partition by pb.sku_key, pb.qty, pb.total_cost order by pb.purchase_item_id) as rn
  from tmp_tania_purchase_base pb
  where pb.sku_key <> ''
)
select
  p.purchase_item_id,
  s.stage_row_id,
  s.unit_raw
from p
join s
  on s.sku_key = p.sku_key
 and s.qty = p.qty
 and s.total_cost = p.total_cost
 and s.rn = p.rn;

create temporary table tmp_tania_match_phase2 on commit drop as
with s0 as (
  select *
  from tmp_tania_stage_base
  where stage_row_id not in (select stage_row_id from tmp_tania_match_phase1)
),
p0 as (
  select *
  from tmp_tania_purchase_base
  where purchase_item_id not in (select purchase_item_id from tmp_tania_match_phase1)
),
s as (
  select
    s0.*,
    row_number() over (partition by s0.name_key, s0.qty, s0.total_cost order by s0.stage_row_id) as rn
  from s0
),
p as (
  select
    p0.*,
    row_number() over (partition by p0.name_key, p0.qty, p0.total_cost order by p0.purchase_item_id) as rn
  from p0
)
select
  p.purchase_item_id,
  s.stage_row_id,
  s.unit_raw
from p
join s
  on s.name_key = p.name_key
 and s.qty = p.qty
 and s.total_cost = p.total_cost
 and s.rn = p.rn;

create temporary table tmp_tania_match_phase3 on commit drop as
with s0 as (
  select *
  from tmp_tania_stage_base
  where stage_row_id not in (
    select stage_row_id from tmp_tania_match_phase1
    union
    select stage_row_id from tmp_tania_match_phase2
  )
),
p0 as (
  select *
  from tmp_tania_purchase_base
  where purchase_item_id not in (
    select purchase_item_id from tmp_tania_match_phase1
    union
    select purchase_item_id from tmp_tania_match_phase2
  )
),
s as (
  select
    s0.*,
    row_number() over (partition by s0.name_key order by s0.qty, s0.total_cost, s0.stage_row_id) as rn
  from s0
),
p as (
  select
    p0.*,
    row_number() over (partition by p0.name_key order by p0.qty, p0.total_cost, p0.purchase_item_id) as rn
  from p0
)
select
  p.purchase_item_id,
  s.stage_row_id,
  s.unit_raw
from p
join s
  on s.name_key = p.name_key
 and s.rn = p.rn;

create temporary table tmp_tania_matched on commit drop as
select purchase_item_id, stage_row_id, unit_raw from tmp_tania_match_phase1
union all
select purchase_item_id, stage_row_id, unit_raw from tmp_tania_match_phase2
union all
select purchase_item_id, stage_row_id, unit_raw from tmp_tania_match_phase3;

with matched as (
  select
    purchase_item_id,
    unit_raw
  from tmp_tania_matched
)
update public.purchase_items pi
set
  unit_name = case
    when m.unit_raw in ('caja', 'cajas', 'cajita', 'cajitas') then 'caja'
    when m.unit_raw in ('par', 'pares') then 'par'
    else coalesce(public.resolve_uom_code(m.unit_raw), m.unit_raw, 'unidad')
  end,
  qty_uom = coalesce(nullif(pi.qty_uom, 0), pi.qty),
  factor_to_base = case
    when coalesce(pi.factor_to_base, 0) <= 0 then 1
    else pi.factor_to_base
  end,
  cost_unit_uom = coalesce(nullif(pi.cost_unit_uom, 0), pi.cost_unit)
from matched m
where pi.id = m.purchase_item_id;

-- 2.1) Validaciones estrictas: abortar si cambia precio/cantidad/total
do $$
declare
  v_total_items int := 0;
  v_matched_items int := 0;
  v_changed int := 0;
begin
  select count(*) into v_total_items from tmp_tania_purchase_before;
  select count(*) into v_matched_items from tmp_tania_matched;

  if v_total_items = 0 then
    raise exception 'No se encontraron items para invoice IMPORT-HOJA1-TANIA-YUCRA-001';
  end if;

  if v_matched_items <> v_total_items then
    raise exception 'Backfill incompleto: items mapeados (%) distinto a items compra (%). Revisa no-mapeados con query de diagnóstico.', v_matched_items, v_total_items;
  end if;

  select count(*)
    into v_changed
  from public.purchase_items pi
  join tmp_tania_purchase_before b on b.id = pi.id
  where
    pi.cost_unit is distinct from b.cost_unit
    or pi.qty is distinct from b.qty
    or pi.total_cost is distinct from b.total_cost;

  if v_changed > 0 then
    raise exception 'Abortado: % items alteraron cost_unit/qty/total_cost', v_changed;
  end if;
end $$;

-- 3) Validación rápida post-backfill
select
  p.invoice_no,
  count(*) as items_total,
  count(*) filter (where coalesce(nullif(trim(pi.unit_name), ''), '') <> '') as items_con_unidad
from public.purchase_items pi
join public.purchases p on p.id = pi.purchase_id
where p.invoice_no = 'IMPORT-HOJA1-TANIA-YUCRA-001'
group by p.invoice_no;

-- Diagnóstico opcional (solo para depurar antes de commit):
-- select pb.*
-- from tmp_tania_purchase_base pb
-- where pb.purchase_item_id not in (select purchase_item_id from tmp_tania_matched)
-- order by pb.name_key, pb.qty, pb.total_cost, pb.purchase_item_id;

commit;

