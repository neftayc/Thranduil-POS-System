-- Minimal stand-in of the POS schema, ONLY to exercise create_sale in a throwaway local cluster
-- (tests/salesAttribution.test.mjs). Never applied to Supabase.
create role authenticated;
create schema auth;
create table auth.users (id uuid primary key, deleted_at timestamptz, banned_until timestamptz);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

create table public.profiles (id uuid primary key references auth.users on delete cascade, full_name text, role text not null default 'cashier');
create function public.user_role() returns text language sql stable security definer set search_path = public as $$ select role from public.profiles where id = auth.uid() $$;
create function public.resolve_payment_method_code(p text) returns text language sql as $$ select case when lower(p) in ('efectivo', 'yape') then lower(p) else null end $$;
create function public.require_uom_code(p text) returns text language sql as $$ select lower(trim(p)) $$;
create table public.customers (id uuid primary key);
create table public.products (id uuid primary key, name text, unit text, sale_price numeric, stock_on_hand numeric, avg_cost numeric, min_stock numeric, updated_at timestamptz);
create function public.resolve_sale_item_pricing(p_product_id uuid, p_unit_name text, p_qty_uom numeric, p_customer_id uuid, p_sale_at timestamptz)
returns jsonb language sql as $$
  select jsonb_build_object('factor', 1, 'qty_base', p_qty_uom, 'price_uom', p.sale_price, 'source', 'base') from public.products p where p.id = p_product_id
$$;
create table public.sales (
  id uuid primary key default gen_random_uuid(), customer_id uuid references public.customers on delete set null,
  sale_date timestamptz not null default now(), total numeric(12,2) not null default 0, payment_method text,
  created_by uuid references auth.users on delete set null, created_at timestamptz not null default now()
);
create table public.inventory_balances (product_id uuid primary key, stock_on_hand numeric, avg_cost numeric, min_stock numeric, updated_at timestamptz);
create table public.stock_cost_layers (
  id uuid primary key default gen_random_uuid(), product_id uuid, source text, layer_date timestamptz, fifo_order bigserial,
  qty_in numeric, qty_remaining numeric, cost_unit numeric, note text, created_by uuid, updated_at timestamptz
);
create table public.sale_items (
  id uuid primary key default gen_random_uuid(), sale_id uuid references public.sales on delete cascade, product_id uuid, unit_name text,
  qty_uom numeric, factor_to_base numeric, price_unit_uom numeric, qty numeric, price_unit numeric, auto_price_unit numeric,
  pricing_source text, pricing_detail jsonb, manual_discount_pct numeric, manual_discount_amount numeric, manual_discount_reason text, total numeric
);
create table public.sale_cost_allocations (sale_id uuid, sale_item_id uuid, product_id uuid, layer_id uuid, qty numeric, cost_unit numeric, total_cost numeric, created_by uuid);
create table public.stock_movements (product_id uuid, movement_type text, qty numeric, cost_unit numeric, ref_table text, ref_id uuid, created_by uuid);
