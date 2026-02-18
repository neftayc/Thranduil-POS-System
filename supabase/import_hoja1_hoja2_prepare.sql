-- Preparacion de tablas staging para import completo:
-- - Catalogo productos (Hoja 1)
-- - Compras corregidas por proveedor (Hoja 1)
-- - Ventas agrupadas por producto+precio (Hoja 2)
-- - Snapshot de stock actual (Hoja 2)

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

create table if not exists public.stg_ventas_hoja2_import (
  sale_ref text,
  customer_code text,
  customer_name text,
  product_sku text,
  product_name text,
  brand text,
  tipo text,
  unit text,
  qty numeric,
  price_unit numeric,
  line_total numeric,
  cost_total numeric,
  profit_total numeric,
  weeks text
);

create table if not exists public.stg_stock_actual_hoja2_import (
  product_sku text,
  product_name text,
  brand text,
  tipo text,
  unit text,
  stock_current numeric
);

create table if not exists public.stg_ventas_hoja2_zero_import (
  product_sku text,
  product_name text,
  brand text,
  tipo text,
  unit text,
  customer_code text,
  customer_name text,
  week_ref text,
  qty numeric,
  price_unit numeric,
  cost_unit numeric,
  sales_total numeric,
  cost_total numeric,
  profit_total numeric
);

-- Opcional: limpiar staging antes de volver a cargar CSV
-- truncate table public.stg_productos_import;
-- truncate table public.stg_compras_tania_import;
-- truncate table public.stg_compras_ayrampo_import;
-- truncate table public.stg_ventas_hoja2_import;
-- truncate table public.stg_stock_actual_hoja2_import;
-- truncate table public.stg_ventas_hoja2_zero_import;
