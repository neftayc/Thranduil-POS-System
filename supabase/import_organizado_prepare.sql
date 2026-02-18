-- Preparacion de tablas staging para import organizado

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
