-- ============================================================
-- IMPORT ORGANIZADO (Inventario.xlsx)
-- ============================================================
-- Este script importa:
-- 1) listado de productos
-- 2) compra sin NUEVO -> proveedor Tania Yucra
-- 3) compra con NUEVO -> proveedor Empresa Ayrampo
--
-- Requisitos previos (Table Editor -> Import data):
-- - Cargar CSV en public.stg_productos_import:
--   /Users/rusbel/Develop/papeleria/data/organizado_1_listado_productos.csv
-- - Cargar CSV en public.stg_compras_tania_import:
--   /Users/rusbel/Develop/papeleria/data/organizado_2_compra_tania_yucra.csv
-- - Cargar CSV en public.stg_compras_ayrampo_import:
--   /Users/rusbel/Develop/papeleria/data/organizado_3_compra_empresa_ayrampo.csv
--
-- Importante:
-- - Este script protege contra doble ejecucion con un batch_code unico.
-- - Si quieres volver a importar, cambia el batch_code.

create table if not exists public.stg_productos_import (
  sku text,
  producto text,
  tipo text,
  marca text,
  unidad text,
  precio_venta_referencia numeric,
  costo_referencia numeric,
  etiqueta_nuevo text
);

create table if not exists public.stg_compras_tania_import (
  supplier_name text,
  supplier_code text,
  purchase_batch text,
  product_sku text,
  product_name text,
  unit text,
  qty numeric,
  cost_unit numeric,
  total_cost numeric,
  etiqueta_nuevo text
);

create table if not exists public.stg_compras_ayrampo_import (
  supplier_name text,
  supplier_code text,
  purchase_batch text,
  product_sku text,
  product_name text,
  unit text,
  qty numeric,
  cost_unit numeric,
  total_cost numeric,
  etiqueta_nuevo text
);

create table if not exists public.import_batches (
  batch_code text primary key,
  created_at timestamptz not null default now()
);

begin;

-- Cambia este valor si necesitas una segunda corrida distinta.
-- Si este batch_code ya existe, el script aborta.
do $$
declare
  v_batch_code constant text := 'IMPORT-ORGANIZADO-2026-02-11-A';
  v_exists boolean;
begin
  select exists(
    select 1
    from public.import_batches
    where batch_code = v_batch_code
  ) into v_exists;

  if v_exists then
    raise exception 'El batch % ya fue ejecutado. Cambia batch_code para reintentar.', v_batch_code;
  end if;

  insert into public.import_batches (batch_code)
  values (v_batch_code);
end $$;

-- Validaciones minimas de staging
do $$
declare
  v_prod int;
  v_tania int;
  v_ayrampo int;
begin
  select count(*) into v_prod from public.stg_productos_import;
  select count(*) into v_tania from public.stg_compras_tania_import;
  select count(*) into v_ayrampo from public.stg_compras_ayrampo_import;

  if v_prod = 0 then
    raise exception 'stg_productos_import esta vacia';
  end if;

  if v_tania = 0 then
    raise exception 'stg_compras_tania_import esta vacia';
  end if;

  if v_ayrampo = 0 then
    raise exception 'stg_compras_ayrampo_import esta vacia';
  end if;
end $$;

-- -------------------------------------------------------------------
-- 1) PRODUCTOS (catalogo base)
-- -------------------------------------------------------------------
insert into public.products (
  sku,
  name,
  product_type,
  brand,
  unit,
  active,
  sale_price,
  min_stock,
  updated_at
)
select
  trim(sp.sku) as sku,
  trim(sp.producto) as name,
  nullif(trim(sp.tipo), ''),
  nullif(trim(sp.marca), ''),
  coalesce(nullif(trim(sp.unidad), ''), 'unidad'),
  true,
  coalesce(sp.precio_venta_referencia, 0)::numeric,
  0,
  now()
from public.stg_productos_import sp
where coalesce(trim(sp.sku), '') <> ''
  and coalesce(trim(sp.producto), '') <> ''
on conflict (sku)
do update set
  name = excluded.name,
  product_type = excluded.product_type,
  brand = excluded.brand,
  unit = excluded.unit,
  active = excluded.active,
  sale_price = excluded.sale_price,
  min_stock = excluded.min_stock,
  updated_at = now();

-- Inventario base (sin movimientos aun): costo de referencia
insert into public.inventory_balances (
  product_id,
  stock_on_hand,
  avg_cost,
  min_stock,
  updated_at
)
select
  p.id,
  coalesce(ib.stock_on_hand, 0),
  case
    when coalesce(sp.costo_referencia, 0) > 0 then sp.costo_referencia
    else coalesce(ib.avg_cost, 0)
  end as avg_cost,
  coalesce(ib.min_stock, 0),
  now()
from public.stg_productos_import sp
join public.products p on p.sku = trim(sp.sku)
left join public.inventory_balances ib on ib.product_id = p.id
on conflict (product_id)
do update set
  avg_cost = case
    when excluded.avg_cost > 0 then excluded.avg_cost
    else public.inventory_balances.avg_cost
  end,
  updated_at = now();

-- Precio actual retail PEN
update public.product_prices pp
set is_current = false,
    valid_to = coalesce(pp.valid_to, now())
from public.stg_productos_import sp
join public.products p on p.sku = trim(sp.sku)
where pp.product_id = p.id
  and pp.price_list = 'retail'
  and pp.currency = 'PEN'
  and pp.is_current = true;

insert into public.product_prices (
  product_id,
  price_list,
  regular_price,
  sale_price,
  currency,
  valid_from,
  is_current,
  created_at
)
select
  p.id,
  'retail',
  coalesce(sp.precio_venta_referencia, 0)::numeric,
  coalesce(sp.precio_venta_referencia, 0)::numeric,
  'PEN',
  now(),
  true,
  now()
from public.stg_productos_import sp
join public.products p on p.sku = trim(sp.sku);

-- Sincroniza campo legacy sale_price en products
update public.products p
set sale_price = pp.sale_price,
    updated_at = now()
from public.product_prices pp
where pp.product_id = p.id
  and pp.price_list = 'retail'
  and pp.currency = 'PEN'
  and pp.is_current = true;

-- -------------------------------------------------------------------
-- 2) PROVEEDORES Y COMPRAS
-- -------------------------------------------------------------------
insert into public.suppliers (name)
select x.name
from (
  values ('Tania Yucra'), ('Empresa Ayrampo')
) as x(name)
where not exists (
  select 1
  from public.suppliers s
  where lower(s.name) = lower(x.name)
);

insert into public.purchases (supplier_id, invoice_no, purchase_date, total_cost, created_at)
select s.id, 'IMPORT-TANIA-YUCRA-001', now(), 0, now()
from public.suppliers s
where lower(s.name) = lower('Tania Yucra')
  and not exists (
    select 1
    from public.purchases p
    where p.invoice_no = 'IMPORT-TANIA-YUCRA-001'
  );

insert into public.purchases (supplier_id, invoice_no, purchase_date, total_cost, created_at)
select s.id, 'IMPORT-EMPRESA-AYRAMPO-001', now(), 0, now()
from public.suppliers s
where lower(s.name) = lower('Empresa Ayrampo')
  and not exists (
    select 1
    from public.purchases p
    where p.invoice_no = 'IMPORT-EMPRESA-AYRAMPO-001'
  );

-- Items compra Tania (solo qty > 0)
insert into public.purchase_items (
  purchase_id,
  product_id,
  qty,
  cost_unit,
  total_cost,
  created_at
)
select
  p.id,
  pr.id,
  st.qty,
  coalesce(st.cost_unit, 0),
  st.qty * coalesce(st.cost_unit, 0),
  now()
from public.stg_compras_tania_import st
join public.products pr on pr.sku = trim(st.product_sku)
join public.purchases p on p.invoice_no = 'IMPORT-TANIA-YUCRA-001'
where coalesce(st.qty, 0) > 0;

-- Items compra Ayrampo (solo qty > 0)
insert into public.purchase_items (
  purchase_id,
  product_id,
  qty,
  cost_unit,
  total_cost,
  created_at
)
select
  p.id,
  pr.id,
  st.qty,
  coalesce(st.cost_unit, 0),
  st.qty * coalesce(st.cost_unit, 0),
  now()
from public.stg_compras_ayrampo_import st
join public.products pr on pr.sku = trim(st.product_sku)
join public.purchases p on p.invoice_no = 'IMPORT-EMPRESA-AYRAMPO-001'
where coalesce(st.qty, 0) > 0;

-- Total por compra
update public.purchases p
set total_cost = x.total_cost
from (
  select pi.purchase_id, sum(pi.total_cost) as total_cost
  from public.purchase_items pi
  group by pi.purchase_id
) x
where p.id = x.purchase_id
  and p.invoice_no in ('IMPORT-TANIA-YUCRA-001', 'IMPORT-EMPRESA-AYRAMPO-001');

-- -------------------------------------------------------------------
-- 3) APLICAR INVENTARIO DESDE COMPRAS IMPORTADAS
-- -------------------------------------------------------------------
with import_lines as (
  select
    pi.product_id,
    sum(pi.qty) as add_qty,
    sum(pi.total_cost) as add_total
  from public.purchase_items pi
  join public.purchases p on p.id = pi.purchase_id
  where p.invoice_no in ('IMPORT-TANIA-YUCRA-001', 'IMPORT-EMPRESA-AYRAMPO-001')
  group by pi.product_id
), ensure_balance as (
  insert into public.inventory_balances (product_id, stock_on_hand, avg_cost, min_stock, updated_at)
  select il.product_id, 0, 0, 0, now()
  from import_lines il
  on conflict (product_id) do nothing
), calc as (
  select
    ib.product_id,
    ib.stock_on_hand as old_stock,
    ib.avg_cost as old_avg,
    il.add_qty,
    il.add_total,
    (ib.stock_on_hand + il.add_qty) as new_stock,
    case
      when (ib.stock_on_hand + il.add_qty) = 0 then 0
      else ((ib.stock_on_hand * ib.avg_cost) + il.add_total) / (ib.stock_on_hand + il.add_qty)
    end as new_avg
  from public.inventory_balances ib
  join import_lines il on il.product_id = ib.product_id
)
update public.inventory_balances ib
set stock_on_hand = calc.new_stock,
    avg_cost = calc.new_avg,
    updated_at = now()
from calc
where ib.product_id = calc.product_id;

-- Sync legacy fields in products (compatibilidad frontend)
update public.products p
set stock_on_hand = ib.stock_on_hand,
    avg_cost = ib.avg_cost,
    min_stock = ib.min_stock,
    updated_at = now()
from public.inventory_balances ib
where p.id = ib.product_id;

-- Movimientos de stock por trazabilidad
insert into public.stock_movements (
  product_id,
  movement_type,
  qty,
  cost_unit,
  ref_table,
  ref_id,
  created_at
)
select
  pi.product_id,
  'purchase',
  pi.qty,
  pi.cost_unit,
  'purchases',
  pi.purchase_id,
  now()
from public.purchase_items pi
join public.purchases p on p.id = pi.purchase_id
where p.invoice_no in ('IMPORT-TANIA-YUCRA-001', 'IMPORT-EMPRESA-AYRAMPO-001');

commit;

-- Verificacion rapida
select 'products' as table_name, count(*) as total from public.products
union all
select 'product_prices_current', count(*) from public.product_prices where is_current = true
union all
select 'inventory_balances', count(*) from public.inventory_balances
union all
select 'purchases_imported', count(*) from public.purchases where invoice_no in ('IMPORT-TANIA-YUCRA-001', 'IMPORT-EMPRESA-AYRAMPO-001')
union all
select 'purchase_items_imported', count(*) from public.purchase_items pi join public.purchases p on p.id = pi.purchase_id where p.invoice_no in ('IMPORT-TANIA-YUCRA-001', 'IMPORT-EMPRESA-AYRAMPO-001');
