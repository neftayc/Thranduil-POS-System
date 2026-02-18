-- Enable required extensions
create extension if not exists pgcrypto;

-- Profiles and roles
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  full_name text,
  role text not null default 'cashier' check (role in ('owner', 'manager', 'cashier')),
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  select count(*) into v_count from public.profiles;

  insert into public.profiles (id, full_name, role)
  values (
    new.id,
    new.raw_user_meta_data->>'full_name',
    case when v_count = 0 then 'owner' else 'cashier' end
  );

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.user_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.user_role() = 'owner', false);
$$;

-- Core tables
create table if not exists public.uom_catalog (
  code text primary key,
  label text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.uom_catalog (code, label, active)
values
  ('unidad', 'Unidad', true),
  ('caja', 'Caja', true),
  ('paquete', 'Paquete', true),
  ('docena', 'Docena', true),
  ('resma', 'Resma', true),
  ('blister', 'Blister', true),
  ('bolsa', 'Bolsa', true)
on conflict (code) do update
set label = excluded.label,
    active = excluded.active;

create table if not exists public.payment_method_catalog (
  code text primary key,
  label text not null,
  active boolean not null default true,
  sort_order integer not null default 100,
  created_at timestamptz not null default now()
);

insert into public.payment_method_catalog (code, label, active, sort_order)
values
  ('efectivo', 'Efectivo', true, 10),
  ('yape', 'Yape', true, 20),
  ('plin', 'Plin', true, 30),
  ('transferencia', 'Transferencia', true, 40),
  ('tarjeta', 'Tarjeta', true, 50)
on conflict (code) do update
set label = excluded.label,
    active = excluded.active,
    sort_order = excluded.sort_order;

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  sku text unique,
  name text not null,
  description text,
  brand text,
  product_type text,
  unit text not null default 'unidad',
  barcode text,
  tax_code text,
  taxable boolean not null default true,
  -- Legacy compatibility fields (kept for migration safety)
  sale_price numeric(12,2) not null default 0,
  stock_on_hand numeric(12,3) not null default 0,
  avg_cost numeric(12,4) not null default 0,
  min_stock numeric(12,3) not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.products add column if not exists description text;
alter table public.products add column if not exists brand text;
alter table public.products add column if not exists product_type text;
alter table public.products add column if not exists barcode text;
alter table public.products add column if not exists tax_code text;
alter table public.products add column if not exists taxable boolean not null default true;
alter table public.products add column if not exists updated_at timestamptz not null default now();

create table if not exists public.product_unit_conversions (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products on delete cascade,
  unit_name text not null,
  factor_to_base numeric(12,6) not null check (factor_to_base > 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists uq_product_unit_conversions_product_unit
  on public.product_unit_conversions (product_id, lower(unit_name));
create index if not exists idx_product_unit_conversions_product
  on public.product_unit_conversions (product_id);

create table if not exists public.product_prices (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products on delete cascade,
  price_list text not null default 'retail',
  regular_price numeric(12,2) not null default 0,
  sale_price numeric(12,2) not null default 0,
  currency char(3) not null default 'PEN',
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  is_current boolean not null default true,
  created_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.inventory_balances (
  product_id uuid primary key references public.products on delete cascade,
  stock_on_hand numeric(12,3) not null default 0,
  avg_cost numeric(12,4) not null default 0,
  min_stock numeric(12,3) not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  email text,
  address text,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  email text,
  address text,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.purchases (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid references public.suppliers on delete set null,
  invoice_no text,
  purchase_date timestamptz not null default now(),
  total_cost numeric(12,2) not null default 0,
  created_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.purchase_items (
  id uuid primary key default gen_random_uuid(),
  purchase_id uuid not null references public.purchases on delete cascade,
  product_id uuid not null references public.products on delete restrict,
  unit_name text not null default 'unidad',
  qty_uom numeric(12,3) not null default 0,
  factor_to_base numeric(12,6) not null default 1,
  cost_unit_uom numeric(12,4) not null default 0,
  qty numeric(12,3) not null,
  cost_unit numeric(12,4) not null,
  total_cost numeric(12,2) not null,
  created_at timestamptz not null default now()
);

create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers on delete set null,
  sale_date timestamptz not null default now(),
  total numeric(12,2) not null default 0,
  payment_method text,
  created_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales on delete cascade,
  product_id uuid not null references public.products on delete restrict,
  unit_name text not null default 'unidad',
  qty_uom numeric(12,3) not null default 0,
  factor_to_base numeric(12,6) not null default 1,
  price_unit_uom numeric(12,4) not null default 0,
  qty numeric(12,3) not null,
  price_unit numeric(12,4) not null,
  total numeric(12,2) not null,
  created_at timestamptz not null default now()
);

alter table public.purchase_items add column if not exists unit_name text not null default 'unidad';
alter table public.purchase_items add column if not exists qty_uom numeric(12,3) not null default 0;
alter table public.purchase_items add column if not exists factor_to_base numeric(12,6) not null default 1;
alter table public.purchase_items add column if not exists cost_unit_uom numeric(12,4) not null default 0;

alter table public.sale_items add column if not exists unit_name text not null default 'unidad';
alter table public.sale_items add column if not exists qty_uom numeric(12,3) not null default 0;
alter table public.sale_items add column if not exists factor_to_base numeric(12,6) not null default 1;
alter table public.sale_items add column if not exists price_unit_uom numeric(12,4) not null default 0;
alter table public.sale_items alter column price_unit type numeric(12,4);

create table if not exists public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products on delete restrict,
  movement_type text not null check (movement_type in ('purchase', 'sale', 'adjust')),
  qty numeric(12,3) not null,
  cost_unit numeric(12,4),
  ref_table text,
  ref_id uuid,
  created_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_purchase_items_purchase on public.purchase_items (purchase_id);
create index if not exists idx_purchase_items_product on public.purchase_items (product_id);
create index if not exists idx_sale_items_sale on public.sale_items (sale_id);
create index if not exists idx_sale_items_product on public.sale_items (product_id);
create index if not exists idx_stock_movements_product on public.stock_movements (product_id);
create index if not exists idx_product_prices_lookup on public.product_prices (product_id, price_list, currency, is_current);

-- Backfill from legacy product fields
insert into public.inventory_balances (product_id, stock_on_hand, avg_cost, min_stock)
select p.id, p.stock_on_hand, p.avg_cost, p.min_stock
from public.products p
on conflict (product_id) do update
set
  stock_on_hand = excluded.stock_on_hand,
  avg_cost = excluded.avg_cost,
  min_stock = excluded.min_stock,
  updated_at = now();

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
  p.sale_price,
  p.sale_price,
  'PEN',
  now(),
  true,
  now()
from public.products p
where not exists (
  select 1
  from public.product_prices pp
  where pp.product_id = p.id
    and pp.price_list = 'retail'
    and pp.currency = 'PEN'
    and pp.is_current = true
);

-- Catalog view used by frontend
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
  coalesce(inv.avg_cost, p.avg_cost, 0) as avg_cost,
  coalesce(inv.min_stock, p.min_stock, 0) as min_stock,
  cp.currency,
  p.created_at,
  p.updated_at
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
left join public.inventory_balances inv on inv.product_id = p.id;

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

create or replace function public.require_uom_code(p_value text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
begin
  v_code := public.resolve_uom_code(p_value);
  if v_code is null then
    raise exception 'Unidad "%" no existe en catálogo', coalesce(p_value, '');
  end if;
  return v_code;
end;
$$;

create or replace function public.resolve_payment_method_code(p_value text)
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

  select p.code
    into v_code
    from public.payment_method_catalog p
    where p.active = true
      and (
        p.code = v_input
        or public.normalize_uom_code(p.label) = v_input
      )
    order by p.sort_order, p.label
    limit 1;

  return v_code;
end;
$$;

create or replace function public.sales_payment_method_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.payment_method := coalesce(public.resolve_payment_method_code(new.payment_method), 'efectivo');
  return new;
end;
$$;

create or replace function public.products_unit_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.unit := public.require_uom_code(coalesce(new.unit, 'unidad'));
  return new;
end;
$$;

update public.products
set unit = coalesce(public.resolve_uom_code(unit), 'unidad')
where coalesce(trim(unit), '') <> '';

delete from public.product_unit_conversions
where public.resolve_uom_code(unit_name) is null;

with ranked as (
  select
    id,
    row_number() over (
      partition by product_id, public.resolve_uom_code(unit_name)
      order by created_at, id
    ) as rn
  from public.product_unit_conversions
  where public.resolve_uom_code(unit_name) is not null
)
delete from public.product_unit_conversions p
using ranked r
where p.id = r.id
  and r.rn > 1;

update public.product_unit_conversions
set unit_name = public.resolve_uom_code(unit_name),
    updated_at = now()
where public.resolve_uom_code(unit_name) is not null;

drop trigger if exists trg_products_unit_guard on public.products;
create trigger trg_products_unit_guard
before insert or update of unit on public.products
for each row
execute function public.products_unit_guard();

update public.sales
set payment_method = coalesce(public.resolve_payment_method_code(payment_method), 'efectivo')
where coalesce(trim(payment_method), '') <> '';

drop trigger if exists trg_sales_payment_method_guard on public.sales;
create trigger trg_sales_payment_method_guard
before insert or update of payment_method on public.sales
for each row
execute function public.sales_payment_method_guard();

-- RPC: upsert product in standard model
create or replace function public.upsert_product_catalog(
  p_id uuid,
  p_sku text,
  p_name text,
  p_unit text,
  p_brand text,
  p_product_type text,
  p_barcode text,
  p_active boolean,
  p_sale_price numeric,
  p_min_stock numeric,
  p_stock_on_hand numeric default null,
  p_avg_cost numeric default null,
  p_currency text default 'PEN'
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product_id uuid;
  v_price_id uuid;
  v_current_price numeric;
  v_currency char(3);
  v_base_unit text;
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  if coalesce(trim(p_name), '') = '' then
    raise exception 'Nombre de producto obligatorio';
  end if;

  v_currency := upper(coalesce(nullif(trim(p_currency), ''), 'PEN'))::char(3);
  v_base_unit := public.require_uom_code(coalesce(nullif(trim(p_unit), ''), 'unidad'));

  if p_id is null and nullif(trim(p_sku), '') is not null then
    select id
      into v_product_id
      from public.products
      where sku = nullif(trim(p_sku), '')
      limit 1;
  end if;

  if p_id is null and v_product_id is null then
    insert into public.products (
      sku,
      name,
      unit,
      brand,
      product_type,
      barcode,
      active,
      sale_price,
      min_stock,
      updated_at
    ) values (
      nullif(trim(p_sku), ''),
      p_name,
      v_base_unit,
      nullif(trim(p_brand), ''),
      nullif(trim(p_product_type), ''),
      nullif(trim(p_barcode), ''),
      coalesce(p_active, true),
      coalesce(p_sale_price, 0),
      coalesce(p_min_stock, 0),
      now()
    )
    returning id into v_product_id;
  else
    update public.products
      set sku = nullif(trim(p_sku), ''),
          name = p_name,
          unit = v_base_unit,
          brand = nullif(trim(p_brand), ''),
          product_type = nullif(trim(p_product_type), ''),
          barcode = nullif(trim(p_barcode), ''),
          active = coalesce(p_active, true),
          sale_price = coalesce(p_sale_price, 0),
          min_stock = coalesce(p_min_stock, 0),
          updated_at = now()
      where id = coalesce(p_id, v_product_id)
      returning id into v_product_id;

    if v_product_id is null then
      raise exception 'Producto no encontrado';
    end if;
  end if;

  insert into public.inventory_balances (product_id, stock_on_hand, avg_cost, min_stock, updated_at)
  values (
    v_product_id,
    coalesce(p_stock_on_hand, 0),
    coalesce(p_avg_cost, 0),
    coalesce(p_min_stock, 0),
    now()
  )
  on conflict (product_id) do nothing;

  update public.inventory_balances
    set stock_on_hand = coalesce(p_stock_on_hand, stock_on_hand),
        avg_cost = coalesce(p_avg_cost, avg_cost),
        min_stock = coalesce(p_min_stock, min_stock),
        updated_at = now()
    where product_id = v_product_id;

  select pp.id, pp.sale_price
    into v_price_id, v_current_price
    from public.product_prices pp
    where pp.product_id = v_product_id
      and pp.price_list = 'retail'
      and pp.currency = v_currency
      and pp.is_current = true
    order by pp.valid_from desc, pp.created_at desc
    limit 1;

  if v_price_id is null then
    insert into public.product_prices (
      product_id,
      price_list,
      regular_price,
      sale_price,
      currency,
      valid_from,
      is_current,
      created_by
    ) values (
      v_product_id,
      'retail',
      coalesce(p_sale_price, 0),
      coalesce(p_sale_price, 0),
      v_currency,
      now(),
      true,
      auth.uid()
    );
  elsif coalesce(v_current_price, 0) <> coalesce(p_sale_price, 0) then
    update public.product_prices
      set is_current = false,
          valid_to = now()
      where id = v_price_id;

    insert into public.product_prices (
      product_id,
      price_list,
      regular_price,
      sale_price,
      currency,
      valid_from,
      is_current,
      created_by
    ) values (
      v_product_id,
      'retail',
      coalesce(p_sale_price, 0),
      coalesce(p_sale_price, 0),
      v_currency,
      now(),
      true,
      auth.uid()
    );
  end if;

  update public.products
    set sale_price = coalesce(p_sale_price, 0),
        stock_on_hand = coalesce(p_stock_on_hand, stock_on_hand),
        avg_cost = coalesce(p_avg_cost, avg_cost),
        min_stock = coalesce(p_min_stock, 0),
        updated_at = now()
    where id = v_product_id;

  return v_product_id;
end;
$$;

create or replace function public.resolve_product_uom_factor(
  p_product_id uuid,
  p_unit_name text
) returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base_unit text;
  v_requested_unit text;
  v_factor numeric;
begin
  select coalesce(nullif(trim(unit), ''), 'unidad')
    into v_base_unit
    from public.products
    where id = p_product_id;

  if v_base_unit is null then
    raise exception 'Producto no encontrado';
  end if;

  v_base_unit := public.require_uom_code(v_base_unit);

  if coalesce(trim(p_unit_name), '') = '' then
    v_requested_unit := v_base_unit;
  else
    v_requested_unit := public.require_uom_code(p_unit_name);
  end if;

  if v_requested_unit = v_base_unit then
    return 1;
  end if;

  select factor_to_base
    into v_factor
    from public.product_unit_conversions
    where product_id = p_product_id
      and lower(unit_name) = v_requested_unit
      and is_active = true
    limit 1;

  if v_factor is null then
    raise exception 'Unidad "%" no configurada para este producto', v_requested_unit;
  end if;

  return v_factor;
end;
$$;

create or replace function public.replace_product_unit_conversions(
  p_product_id uuid,
  p_items jsonb
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base_unit text;
  v_item jsonb;
  v_unit_name text;
  v_factor numeric;
  v_inserted integer := 0;
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  select coalesce(nullif(trim(unit), ''), 'unidad')
    into v_base_unit
    from public.products
    where id = p_product_id;

  if v_base_unit is null then
    raise exception 'Producto no encontrado';
  end if;

  v_base_unit := public.require_uom_code(v_base_unit);

  delete from public.product_unit_conversions
  where product_id = p_product_id;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    return 0;
  end if;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    if coalesce(trim(v_item->>'unit_name'), '') = '' then
      continue;
    end if;
    v_unit_name := public.require_uom_code(v_item->>'unit_name');

    if v_unit_name = v_base_unit then
      continue;
    end if;

    v_factor := nullif(v_item->>'factor_to_base', '')::numeric;
    if v_factor is null or v_factor <= 0 then
      raise exception 'Factor inválido para unidad "%"', v_unit_name;
    end if;

    insert into public.product_unit_conversions (
      product_id,
      unit_name,
      factor_to_base,
      is_active,
      created_at,
      updated_at
    ) values (
      p_product_id,
      v_unit_name,
      v_factor,
      coalesce((v_item->>'is_active')::boolean, true),
      now(),
      now()
    );

    v_inserted := v_inserted + 1;
  end loop;

  return v_inserted;
end;
$$;

-- RPC: create purchase
create or replace function public.create_purchase(
  p_supplier_id uuid,
  p_invoice_no text,
  p_items jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_purchase_id uuid;
  v_item jsonb;
  v_product_id uuid;
  v_qty_input numeric;
  v_cost_input numeric;
  v_qty_base numeric;
  v_cost_base numeric;
  v_unit_name text;
  v_base_unit text;
  v_factor numeric;
  v_old_stock numeric;
  v_old_avg numeric;
  v_min_stock numeric;
  v_new_stock numeric;
  v_new_avg numeric;
  v_total numeric := 0;
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'Items invalidos';
  end if;

  insert into public.purchases (supplier_id, invoice_no, created_by, total_cost)
  values (p_supplier_id, p_invoice_no, auth.uid(), 0)
  returning id into v_purchase_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_product_id := (v_item->>'product_id')::uuid;
    v_qty_input := coalesce(nullif(v_item->>'qty', '')::numeric, 0);
    v_cost_input := coalesce(nullif(v_item->>'cost_unit', '')::numeric, 0);

    if v_qty_input <= 0 then
      raise exception 'Cantidad invalida';
    end if;

    if v_cost_input < 0 then
      raise exception 'Costo invalido';
    end if;

    select coalesce(nullif(trim(unit), ''), 'unidad')
      into v_base_unit
      from public.products
      where id = v_product_id;

    if v_base_unit is null then
      raise exception 'Producto no encontrado';
    end if;

    v_base_unit := public.require_uom_code(v_base_unit);
    if coalesce(trim(v_item->>'unit_name'), '') = '' then
      v_unit_name := v_base_unit;
    else
      v_unit_name := public.require_uom_code(v_item->>'unit_name');
    end if;
    v_factor := public.resolve_product_uom_factor(v_product_id, v_unit_name);
    v_qty_base := v_qty_input * v_factor;

    if v_qty_base <= 0 then
      raise exception 'Cantidad base invalida';
    end if;

    v_cost_base := v_cost_input / v_factor;

    insert into public.inventory_balances (product_id, stock_on_hand, avg_cost, min_stock, updated_at)
    values (
      v_product_id,
      0,
      0,
      coalesce((select p.min_stock from public.products p where p.id = v_product_id), 0),
      now()
    )
    on conflict (product_id) do nothing;

    select stock_on_hand, avg_cost, min_stock
      into v_old_stock, v_old_avg, v_min_stock
      from public.inventory_balances
      where product_id = v_product_id
      for update;

    v_new_stock := v_old_stock + v_qty_base;
    if v_new_stock = 0 then
      v_new_avg := 0;
    else
      v_new_avg := ((v_old_stock * v_old_avg) + (v_qty_base * v_cost_base)) / v_new_stock;
    end if;

    update public.inventory_balances
      set stock_on_hand = v_new_stock,
          avg_cost = v_new_avg,
          updated_at = now()
      where product_id = v_product_id;

    update public.products
      set stock_on_hand = v_new_stock,
          avg_cost = v_new_avg,
          min_stock = coalesce(v_min_stock, min_stock),
          updated_at = now()
      where id = v_product_id;

    insert into public.purchase_items (
      purchase_id,
      product_id,
      unit_name,
      qty_uom,
      factor_to_base,
      cost_unit_uom,
      qty,
      cost_unit,
      total_cost
    )
    values (
      v_purchase_id,
      v_product_id,
      v_unit_name,
      v_qty_input,
      v_factor,
      v_cost_input,
      v_qty_base,
      v_cost_base,
      v_qty_input * v_cost_input
    );

    insert into public.stock_movements (product_id, movement_type, qty, cost_unit, ref_table, ref_id, created_by)
    values (v_product_id, 'purchase', v_qty_base, v_cost_base, 'purchases', v_purchase_id, auth.uid());

    v_total := v_total + (v_qty_input * v_cost_input);
  end loop;

  update public.purchases
    set total_cost = v_total
    where id = v_purchase_id;

  return v_purchase_id;
end;
$$;

-- RPC: create sale
create or replace function public.create_sale(
  p_customer_id uuid,
  p_payment_method text,
  p_items jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale_id uuid;
  v_item jsonb;
  v_product_id uuid;
  v_qty_input numeric;
  v_price_input numeric;
  v_qty_base numeric;
  v_price_base numeric;
  v_unit_name text;
  v_base_unit text;
  v_factor numeric;
  v_old_stock numeric;
  v_old_avg numeric;
  v_min_stock numeric;
  v_product_name text;
  v_payment_method_code text;
  v_total numeric := 0;
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'Items invalidos';
  end if;

  v_payment_method_code := coalesce(public.resolve_payment_method_code(p_payment_method), 'efectivo');

  insert into public.sales (customer_id, payment_method, created_by, total)
  values (p_customer_id, v_payment_method_code, auth.uid(), 0)
  returning id into v_sale_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_product_id := (v_item->>'product_id')::uuid;
    v_qty_input := coalesce(nullif(v_item->>'qty', '')::numeric, 0);
    v_price_input := coalesce(nullif(v_item->>'price_unit', '')::numeric, 0);

    if v_qty_input <= 0 then
      raise exception 'Cantidad invalida';
    end if;

    if v_price_input < 0 then
      raise exception 'Precio invalido';
    end if;

    select coalesce(nullif(trim(unit), ''), 'unidad')
      into v_base_unit
      from public.products
      where id = v_product_id;

    if v_base_unit is null then
      raise exception 'Producto no encontrado';
    end if;

    v_base_unit := public.require_uom_code(v_base_unit);
    if coalesce(trim(v_item->>'unit_name'), '') = '' then
      v_unit_name := v_base_unit;
    else
      v_unit_name := public.require_uom_code(v_item->>'unit_name');
    end if;
    v_factor := public.resolve_product_uom_factor(v_product_id, v_unit_name);
    v_qty_base := v_qty_input * v_factor;

    if v_qty_base <= 0 then
      raise exception 'Cantidad base invalida';
    end if;

    v_price_base := v_price_input / v_factor;

    insert into public.inventory_balances (product_id, stock_on_hand, avg_cost, min_stock, updated_at)
    values (
      v_product_id,
      coalesce((select p.stock_on_hand from public.products p where p.id = v_product_id), 0),
      coalesce((select p.avg_cost from public.products p where p.id = v_product_id), 0),
      coalesce((select p.min_stock from public.products p where p.id = v_product_id), 0),
      now()
    )
    on conflict (product_id) do nothing;

    select ib.stock_on_hand, ib.avg_cost, ib.min_stock, p.name
      into v_old_stock, v_old_avg, v_min_stock, v_product_name
      from public.inventory_balances ib
      join public.products p on p.id = ib.product_id
      where ib.product_id = v_product_id
      for update;

    if v_old_stock < v_qty_base then
      raise exception 'Stock insuficiente para %', v_product_name;
    end if;

    update public.inventory_balances
      set stock_on_hand = v_old_stock - v_qty_base,
          updated_at = now()
      where product_id = v_product_id;

    update public.products
      set stock_on_hand = v_old_stock - v_qty_base,
          avg_cost = v_old_avg,
          min_stock = coalesce(v_min_stock, min_stock),
          updated_at = now()
      where id = v_product_id;

    insert into public.sale_items (
      sale_id,
      product_id,
      unit_name,
      qty_uom,
      factor_to_base,
      price_unit_uom,
      qty,
      price_unit,
      total
    )
    values (
      v_sale_id,
      v_product_id,
      v_unit_name,
      v_qty_input,
      v_factor,
      v_price_input,
      v_qty_base,
      v_price_base,
      v_qty_input * v_price_input
    );

    insert into public.stock_movements (product_id, movement_type, qty, cost_unit, ref_table, ref_id, created_by)
    values (v_product_id, 'sale', -v_qty_base, v_old_avg, 'sales', v_sale_id, auth.uid());

    v_total := v_total + (v_qty_input * v_price_input);
  end loop;

  update public.sales
    set total = v_total
    where id = v_sale_id;

  return v_sale_id;
end;
$$;

grant execute on function public.create_purchase(uuid, text, jsonb) to authenticated;
grant execute on function public.create_sale(uuid, text, jsonb) to authenticated;
grant execute on function public.upsert_product_catalog(uuid, text, text, text, text, text, text, boolean, numeric, numeric, numeric, numeric, text) to authenticated;
grant execute on function public.resolve_product_uom_factor(uuid, text) to authenticated;
grant execute on function public.replace_product_unit_conversions(uuid, jsonb) to authenticated;
grant execute on function public.resolve_uom_code(text) to authenticated;
grant execute on function public.resolve_payment_method_code(text) to authenticated;
grant select on public.product_catalog to authenticated;
grant select on public.uom_catalog to authenticated;
grant select on public.payment_method_catalog to authenticated;

-- Row Level Security
alter table public.profiles enable row level security;
drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select" on public.profiles
  for select using (auth.uid() is not null);
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id);
drop policy if exists "profiles_update_owner" on public.profiles;
create policy "profiles_update_owner" on public.profiles
  for update using (public.is_owner());

alter table public.products enable row level security;
drop policy if exists "products_all_auth" on public.products;
create policy "products_all_auth" on public.products
  for all using (auth.uid() is not null)
  with check (auth.uid() is not null);

alter table public.uom_catalog enable row level security;
drop policy if exists "uom_catalog_select_auth" on public.uom_catalog;
create policy "uom_catalog_select_auth" on public.uom_catalog
  for select using (auth.uid() is not null);
drop policy if exists "uom_catalog_insert_owner" on public.uom_catalog;
create policy "uom_catalog_insert_owner" on public.uom_catalog
  for insert with check (public.is_owner());
drop policy if exists "uom_catalog_update_owner" on public.uom_catalog;
create policy "uom_catalog_update_owner" on public.uom_catalog
  for update using (public.is_owner())
  with check (public.is_owner());
drop policy if exists "uom_catalog_delete_owner" on public.uom_catalog;
create policy "uom_catalog_delete_owner" on public.uom_catalog
  for delete using (public.is_owner());

alter table public.payment_method_catalog enable row level security;
drop policy if exists "payment_method_catalog_select_auth" on public.payment_method_catalog;
create policy "payment_method_catalog_select_auth" on public.payment_method_catalog
  for select using (auth.uid() is not null);
drop policy if exists "payment_method_catalog_insert_owner" on public.payment_method_catalog;
create policy "payment_method_catalog_insert_owner" on public.payment_method_catalog
  for insert with check (public.is_owner());
drop policy if exists "payment_method_catalog_update_owner" on public.payment_method_catalog;
create policy "payment_method_catalog_update_owner" on public.payment_method_catalog
  for update using (public.is_owner())
  with check (public.is_owner());
drop policy if exists "payment_method_catalog_delete_owner" on public.payment_method_catalog;
create policy "payment_method_catalog_delete_owner" on public.payment_method_catalog
  for delete using (public.is_owner());

alter table public.product_prices enable row level security;
drop policy if exists "product_prices_all_auth" on public.product_prices;
create policy "product_prices_all_auth" on public.product_prices
  for all using (auth.uid() is not null)
  with check (auth.uid() is not null);

alter table public.product_unit_conversions enable row level security;
drop policy if exists "product_unit_conversions_all_auth" on public.product_unit_conversions;
create policy "product_unit_conversions_all_auth" on public.product_unit_conversions
  for all using (auth.uid() is not null)
  with check (auth.uid() is not null);

alter table public.inventory_balances enable row level security;
drop policy if exists "inventory_balances_all_auth" on public.inventory_balances;
create policy "inventory_balances_all_auth" on public.inventory_balances
  for all using (auth.uid() is not null)
  with check (auth.uid() is not null);

alter table public.customers enable row level security;
drop policy if exists "customers_all_auth" on public.customers;
create policy "customers_all_auth" on public.customers
  for all using (auth.uid() is not null)
  with check (auth.uid() is not null);

alter table public.suppliers enable row level security;
drop policy if exists "suppliers_all_auth" on public.suppliers;
create policy "suppliers_all_auth" on public.suppliers
  for all using (auth.uid() is not null)
  with check (auth.uid() is not null);

alter table public.purchases enable row level security;
drop policy if exists "purchases_all_auth" on public.purchases;
create policy "purchases_all_auth" on public.purchases
  for all using (auth.uid() is not null)
  with check (auth.uid() is not null);

alter table public.purchase_items enable row level security;
drop policy if exists "purchase_items_all_auth" on public.purchase_items;
create policy "purchase_items_all_auth" on public.purchase_items
  for all using (auth.uid() is not null)
  with check (auth.uid() is not null);

alter table public.sales enable row level security;
drop policy if exists "sales_all_auth" on public.sales;
create policy "sales_all_auth" on public.sales
  for all using (auth.uid() is not null)
  with check (auth.uid() is not null);

alter table public.sale_items enable row level security;
drop policy if exists "sale_items_all_auth" on public.sale_items;
create policy "sale_items_all_auth" on public.sale_items
  for all using (auth.uid() is not null)
  with check (auth.uid() is not null);

alter table public.stock_movements enable row level security;
drop policy if exists "stock_movements_all_auth" on public.stock_movements;
create policy "stock_movements_all_auth" on public.stock_movements
  for all using (auth.uid() is not null)
  with check (auth.uid() is not null);

-- Conteo fisico de inventario (sesiones + detalle de ajustes)
create table if not exists public.inventory_count_sessions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  status text not null check (status in ('open', 'closed')) default 'open',
  notes text,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  created_by uuid references auth.users on delete set null,
  closed_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.inventory_count_items (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.inventory_count_sessions on delete cascade,
  product_id uuid not null references public.products on delete restrict,
  stock_system numeric(12,3) not null default 0,
  counted numeric(12,3) not null default 0,
  non_sellable numeric(12,3) not null default 0,
  stock_final numeric(12,3) not null default 0,
  delta_qty numeric(12,3) not null default 0,
  avg_cost numeric(12,4) not null default 0,
  reason text not null,
  reconfirmed boolean not null default false,
  applied boolean not null default false,
  applied_at timestamptz,
  applied_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, product_id)
);

create index if not exists idx_inventory_count_sessions_status
  on public.inventory_count_sessions (status, opened_at desc);
create index if not exists idx_inventory_count_items_session
  on public.inventory_count_items (session_id);
create index if not exists idx_inventory_count_items_product
  on public.inventory_count_items (product_id);

alter table public.inventory_count_sessions enable row level security;
drop policy if exists "inventory_count_sessions_all_auth" on public.inventory_count_sessions;
create policy "inventory_count_sessions_all_auth" on public.inventory_count_sessions
  for all using (auth.uid() is not null)
  with check (auth.uid() is not null);

alter table public.inventory_count_items enable row level security;
drop policy if exists "inventory_count_items_all_auth" on public.inventory_count_items;
create policy "inventory_count_items_all_auth" on public.inventory_count_items
  for all using (auth.uid() is not null)
  with check (auth.uid() is not null);

-- ===== Reglas de venta (pricing rules) =====
-- Patch: reglas de venta (presentación, mayorista, promoción, tipo de cliente, descuento manual)
-- Ejecutar en Supabase SQL Editor

create table if not exists public.customer_groups (
  code text primary key,
  label text not null,
  active boolean not null default true,
  sort_order integer not null default 100,
  created_at timestamptz not null default now()
);

insert into public.customer_groups (code, label, active, sort_order)
values
  ('minorista', 'Minorista', true, 10),
  ('mayorista', 'Mayorista', true, 20),
  ('institucional', 'Institucional', true, 30)
on conflict (code) do update
set label = excluded.label,
    active = excluded.active,
    sort_order = excluded.sort_order;

alter table public.customers add column if not exists customer_group text;
update public.customers c
set customer_group = 'minorista'
where coalesce(trim(c.customer_group), '') = ''
   or not exists (
     select 1
     from public.customer_groups g
     where g.code = c.customer_group
   );

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'customers_customer_group_fkey'
      and conrelid = 'public.customers'::regclass
  ) then
    alter table public.customers
      add constraint customers_customer_group_fkey
      foreign key (customer_group) references public.customer_groups (code) on update cascade;
  end if;
end $$;

alter table public.customers alter column customer_group set default 'minorista';

create table if not exists public.product_customer_group_prices (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products on delete cascade,
  customer_group text references public.customer_groups (code) on update cascade,
  unit_price_base numeric(12,4) not null check (unit_price_base >= 0),
  currency char(3) not null default 'PEN',
  starts_at timestamptz,
  ends_at timestamptz,
  priority integer not null default 100,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_product_customer_group_prices_product
  on public.product_customer_group_prices (product_id, customer_group, active, priority);

create table if not exists public.product_presentation_prices (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products on delete cascade,
  unit_name text not null references public.uom_catalog (code) on update cascade,
  customer_group text references public.customer_groups (code) on update cascade,
  price_uom numeric(12,4) not null check (price_uom >= 0),
  currency char(3) not null default 'PEN',
  starts_at timestamptz,
  ends_at timestamptz,
  priority integer not null default 100,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_product_presentation_prices_product
  on public.product_presentation_prices (product_id, unit_name, customer_group, active, priority);

create table if not exists public.product_wholesale_tiers (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products on delete cascade,
  customer_group text references public.customer_groups (code) on update cascade,
  min_qty_base numeric(12,3) not null check (min_qty_base > 0),
  unit_price_base numeric(12,4) not null check (unit_price_base >= 0),
  starts_at timestamptz,
  ends_at timestamptz,
  priority integer not null default 100,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_product_wholesale_tiers_product
  on public.product_wholesale_tiers (product_id, customer_group, min_qty_base desc, active, priority);

create table if not exists public.product_promotions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  product_id uuid not null references public.products on delete cascade,
  unit_name text references public.uom_catalog (code) on update cascade,
  customer_group text references public.customer_groups (code) on update cascade,
  promo_type text not null check (promo_type in ('percent', 'fixed_price_uom')),
  promo_value numeric(12,4) not null check (promo_value > 0),
  min_qty_base numeric(12,3) not null default 1 check (min_qty_base > 0),
  starts_at timestamptz not null,
  ends_at timestamptz,
  priority integer not null default 100,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_product_promotions_product
  on public.product_promotions (product_id, customer_group, unit_name, active, priority);

alter table public.sale_items add column if not exists auto_price_unit numeric(12,4) not null default 0;
alter table public.sale_items add column if not exists pricing_source text;
alter table public.sale_items add column if not exists pricing_detail jsonb not null default '{}'::jsonb;
alter table public.sale_items add column if not exists manual_discount_pct numeric(6,2) not null default 0;
alter table public.sale_items add column if not exists manual_discount_amount numeric(12,4) not null default 0;
alter table public.sale_items add column if not exists manual_discount_reason text;

create or replace function public.customer_group_for_sale(p_customer_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group text;
begin
  if p_customer_id is null then
    return 'minorista';
  end if;

  select c.customer_group
    into v_group
    from public.customers c
    where c.id = p_customer_id
    limit 1;

  if v_group is null then
    return 'minorista';
  end if;

  if not exists (
    select 1
    from public.customer_groups g
    where g.code = v_group
      and g.active = true
  ) then
    return 'minorista';
  end if;

  return v_group;
end;
$$;

create or replace function public.resolve_sale_item_pricing(
  p_product_id uuid,
  p_unit_name text,
  p_qty_uom numeric,
  p_customer_id uuid default null,
  p_sale_at timestamptz default now()
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base_unit text;
  v_unit_name text;
  v_factor numeric;
  v_qty_uom numeric;
  v_qty_base numeric;
  v_customer_group text;
  v_base_price numeric;
  v_price_base numeric;
  v_price_uom numeric;
  v_currency char(3);
  v_rule_id uuid;
  v_rule_type text := 'base';
  v_source text := 'base';
  v_candidate numeric;
  v_promo_type text;
  v_promo_value numeric;
begin
  select
    coalesce(nullif(trim(p.unit), ''), 'unidad'),
    coalesce(pc.sale_price, p.sale_price, 0),
    coalesce(pc.currency, 'PEN')
    into v_base_unit, v_base_price, v_currency
  from public.products p
  left join public.product_catalog pc on pc.id = p.id
  where p.id = p_product_id
  limit 1;

  if v_base_unit is null then
    raise exception 'Producto no encontrado';
  end if;

  v_base_unit := public.require_uom_code(v_base_unit);
  if coalesce(trim(p_unit_name), '') = '' then
    v_unit_name := v_base_unit;
  else
    v_unit_name := public.require_uom_code(p_unit_name);
  end if;

  v_factor := public.resolve_product_uom_factor(p_product_id, v_unit_name);
  v_qty_uom := greatest(coalesce(p_qty_uom, 0), 0);
  if v_qty_uom = 0 then
    v_qty_uom := 1;
  end if;
  v_qty_base := v_qty_uom * v_factor;
  v_customer_group := public.customer_group_for_sale(p_customer_id);

  v_price_base := coalesce(v_base_price, 0);

  -- Precio por tipo de cliente
  v_rule_id := null;
  select r.id, r.unit_price_base
    into v_rule_id, v_candidate
    from public.product_customer_group_prices r
    where r.product_id = p_product_id
      and r.active = true
      and (r.customer_group is null or r.customer_group = v_customer_group)
      and (r.starts_at is null or r.starts_at <= p_sale_at)
      and (r.ends_at is null or r.ends_at >= p_sale_at)
    order by
      case when r.customer_group = v_customer_group then 0 else 1 end,
      r.priority asc,
      r.starts_at desc nulls last,
      r.created_at desc
    limit 1;

  if v_rule_id is not null then
    v_price_base := v_candidate;
    v_rule_type := 'customer_group';
    v_source := 'customer_group';
  end if;

  v_price_uom := v_price_base * v_factor;

  -- Precio por presentación
  v_rule_id := null;
  select r.id, r.price_uom
    into v_rule_id, v_candidate
    from public.product_presentation_prices r
    where r.product_id = p_product_id
      and r.unit_name = v_unit_name
      and r.active = true
      and (r.customer_group is null or r.customer_group = v_customer_group)
      and (r.starts_at is null or r.starts_at <= p_sale_at)
      and (r.ends_at is null or r.ends_at >= p_sale_at)
    order by
      case when r.customer_group = v_customer_group then 0 else 1 end,
      r.priority asc,
      r.starts_at desc nulls last,
      r.created_at desc
    limit 1;

  if v_rule_id is not null then
    v_price_uom := v_candidate;
    v_price_base := case when v_factor = 0 then 0 else v_price_uom / v_factor end;
    v_rule_type := 'presentation';
    v_source := 'presentation';
  end if;

  -- Precio mayorista por cantidad
  v_rule_id := null;
  select r.id, r.unit_price_base
    into v_rule_id, v_candidate
    from public.product_wholesale_tiers r
    where r.product_id = p_product_id
      and r.active = true
      and r.min_qty_base <= v_qty_base
      and (r.customer_group is null or r.customer_group = v_customer_group)
      and (r.starts_at is null or r.starts_at <= p_sale_at)
      and (r.ends_at is null or r.ends_at >= p_sale_at)
    order by
      r.min_qty_base desc,
      case when r.customer_group = v_customer_group then 0 else 1 end,
      r.priority asc,
      r.created_at desc
    limit 1;

  if v_rule_id is not null then
    v_price_base := v_candidate;
    v_price_uom := v_price_base * v_factor;
    v_rule_type := 'wholesale';
    v_source := 'wholesale';
  end if;

  -- Promoción temporal
  v_rule_id := null;
  select p.id, p.promo_type, p.promo_value
    into v_rule_id, v_promo_type, v_promo_value
    from public.product_promotions p
    where p.product_id = p_product_id
      and p.active = true
      and p.min_qty_base <= v_qty_base
      and p.starts_at <= p_sale_at
      and (p.ends_at is null or p.ends_at >= p_sale_at)
      and (p.customer_group is null or p.customer_group = v_customer_group)
      and (p.unit_name is null or p.unit_name = v_unit_name)
    order by
      case when p.customer_group = v_customer_group then 0 else 1 end,
      case when p.unit_name = v_unit_name then 0 else 1 end,
      p.priority asc,
      p.starts_at desc,
      p.created_at desc
    limit 1;

  if v_rule_id is not null then
    if v_promo_type = 'percent' then
      v_price_uom := v_price_uom * (1 - (v_promo_value / 100));
      v_source := v_source || '+promo_percent';
      v_rule_type := 'promotion_percent';
    elsif v_promo_type = 'fixed_price_uom' then
      v_price_uom := v_promo_value;
      v_source := v_source || '+promo_fixed';
      v_rule_type := 'promotion_fixed';
    end if;
    v_price_base := case when v_factor = 0 then 0 else v_price_uom / v_factor end;
  end if;

  v_price_uom := greatest(round(v_price_uom::numeric, 4), 0);
  v_price_base := greatest(round(v_price_base::numeric, 4), 0);

  return jsonb_build_object(
    'price_uom', v_price_uom,
    'price_base', v_price_base,
    'factor', v_factor,
    'qty_base', v_qty_base,
    'unit_name', v_unit_name,
    'base_unit', v_base_unit,
    'customer_group', v_customer_group,
    'currency', v_currency,
    'source', v_source,
    'rule_type', v_rule_type
  );
end;
$$;

create or replace function public.create_sale(
  p_customer_id uuid,
  p_payment_method text,
  p_items jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale_id uuid;
  v_item jsonb;
  v_product_id uuid;
  v_qty_input numeric;
  v_price_input numeric;
  v_qty_base numeric;
  v_price_base numeric;
  v_unit_name text;
  v_base_unit text;
  v_factor numeric;
  v_old_stock numeric;
  v_old_avg numeric;
  v_min_stock numeric;
  v_product_name text;
  v_total numeric := 0;
  v_payment_method_code text;
  v_pricing jsonb;
  v_auto_price_uom numeric;
  v_final_price_uom numeric;
  v_manual_discount_pct numeric;
  v_manual_discount_amount numeric;
  v_manual_discount_reason text;
  v_role text;
  v_can_manual_discount boolean := false;
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'Items invalidos';
  end if;

  v_payment_method_code := coalesce(public.resolve_payment_method_code(p_payment_method), 'efectivo');
  v_role := coalesce(public.user_role(), 'cashier');
  v_can_manual_discount := v_role in ('owner', 'manager');

  insert into public.sales (customer_id, payment_method, created_by, total)
  values (p_customer_id, v_payment_method_code, auth.uid(), 0)
  returning id into v_sale_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_product_id := (v_item->>'product_id')::uuid;
    v_qty_input := coalesce(nullif(v_item->>'qty', '')::numeric, 0);
    v_price_input := nullif(v_item->>'price_unit', '')::numeric;
    v_manual_discount_pct := greatest(coalesce(nullif(v_item->>'manual_discount_pct', '')::numeric, 0), 0);
    v_manual_discount_amount := greatest(coalesce(nullif(v_item->>'manual_discount_amount', '')::numeric, 0), 0);
    v_manual_discount_reason := nullif(trim(coalesce(v_item->>'manual_discount_reason', '')), '');

    if v_qty_input <= 0 then
      raise exception 'Cantidad invalida';
    end if;

    if v_price_input is not null and v_price_input < 0 then
      raise exception 'Precio invalido';
    end if;

    select coalesce(nullif(trim(unit), ''), 'unidad')
      into v_base_unit
      from public.products
      where id = v_product_id;

    if v_base_unit is null then
      raise exception 'Producto no encontrado';
    end if;

    v_base_unit := public.require_uom_code(v_base_unit);
    if coalesce(trim(v_item->>'unit_name'), '') = '' then
      v_unit_name := v_base_unit;
    else
      v_unit_name := public.require_uom_code(v_item->>'unit_name');
    end if;

    v_pricing := public.resolve_sale_item_pricing(
      p_product_id := v_product_id,
      p_unit_name := v_unit_name,
      p_qty_uom := v_qty_input,
      p_customer_id := p_customer_id,
      p_sale_at := now()
    );

    v_factor := coalesce((v_pricing->>'factor')::numeric, 1);
    v_qty_base := coalesce((v_pricing->>'qty_base')::numeric, v_qty_input * v_factor);
    v_auto_price_uom := coalesce((v_pricing->>'price_uom')::numeric, 0);
    v_final_price_uom := v_auto_price_uom;

    if (
      v_manual_discount_pct > 0
      or v_manual_discount_amount > 0
      or (v_price_input is not null and abs(v_price_input - v_auto_price_uom) > 0.0001)
    ) then
      if not v_can_manual_discount then
        raise exception 'Tu rol no permite descuento o ajuste manual de precio';
      end if;
      if v_manual_discount_reason is null then
        raise exception 'Motivo obligatorio para descuento o ajuste manual';
      end if;
    end if;

    if v_manual_discount_pct > 0 then
      v_final_price_uom := v_final_price_uom * (1 - (v_manual_discount_pct / 100));
    end if;

    if v_manual_discount_amount > 0 then
      v_final_price_uom := v_final_price_uom - v_manual_discount_amount;
    end if;

    if v_price_input is not null and abs(v_price_input - v_auto_price_uom) > 0.0001 then
      v_final_price_uom := v_price_input;
    end if;

    v_final_price_uom := round(v_final_price_uom::numeric, 4);
    if v_final_price_uom < 0 then
      raise exception 'Precio final inválido para %', v_product_id;
    end if;

    v_price_base := case when v_factor = 0 then 0 else round((v_final_price_uom / v_factor)::numeric, 4) end;

    insert into public.inventory_balances (product_id, stock_on_hand, avg_cost, min_stock, updated_at)
    values (
      v_product_id,
      coalesce((select p.stock_on_hand from public.products p where p.id = v_product_id), 0),
      coalesce((select p.avg_cost from public.products p where p.id = v_product_id), 0),
      coalesce((select p.min_stock from public.products p where p.id = v_product_id), 0),
      now()
    )
    on conflict (product_id) do nothing;

    select ib.stock_on_hand, ib.avg_cost, ib.min_stock, p.name
      into v_old_stock, v_old_avg, v_min_stock, v_product_name
      from public.inventory_balances ib
      join public.products p on p.id = ib.product_id
      where ib.product_id = v_product_id
      for update;

    if v_old_stock < v_qty_base then
      raise exception 'Stock insuficiente para %', v_product_name;
    end if;

    update public.inventory_balances
      set stock_on_hand = v_old_stock - v_qty_base,
          updated_at = now()
      where product_id = v_product_id;

    update public.products
      set stock_on_hand = v_old_stock - v_qty_base,
          avg_cost = v_old_avg,
          min_stock = coalesce(v_min_stock, min_stock),
          updated_at = now()
      where id = v_product_id;

    insert into public.sale_items (
      sale_id,
      product_id,
      unit_name,
      qty_uom,
      factor_to_base,
      price_unit_uom,
      qty,
      price_unit,
      auto_price_unit,
      pricing_source,
      pricing_detail,
      manual_discount_pct,
      manual_discount_amount,
      manual_discount_reason,
      total
    )
    values (
      v_sale_id,
      v_product_id,
      v_unit_name,
      v_qty_input,
      v_factor,
      v_final_price_uom,
      v_qty_base,
      v_price_base,
      v_auto_price_uom,
      coalesce(v_pricing->>'source', 'base'),
      v_pricing,
      v_manual_discount_pct,
      v_manual_discount_amount,
      v_manual_discount_reason,
      v_qty_input * v_final_price_uom
    );

    insert into public.stock_movements (product_id, movement_type, qty, cost_unit, ref_table, ref_id, created_by)
    values (v_product_id, 'sale', -v_qty_base, v_old_avg, 'sales', v_sale_id, auth.uid());

    v_total := v_total + (v_qty_input * v_final_price_uom);
  end loop;

  update public.sales
    set total = v_total
    where id = v_sale_id;

  return v_sale_id;
end;
$$;

grant execute on function public.customer_group_for_sale(uuid) to authenticated;
grant execute on function public.resolve_sale_item_pricing(uuid, text, numeric, uuid, timestamptz) to authenticated;

grant select on public.customer_groups to authenticated;
grant select on public.product_customer_group_prices to authenticated;
grant select on public.product_presentation_prices to authenticated;
grant select on public.product_wholesale_tiers to authenticated;
grant select on public.product_promotions to authenticated;

alter table public.customer_groups enable row level security;
drop policy if exists "customer_groups_select_auth" on public.customer_groups;
create policy "customer_groups_select_auth" on public.customer_groups
  for select using (auth.uid() is not null);
drop policy if exists "customer_groups_insert_owner" on public.customer_groups;
create policy "customer_groups_insert_owner" on public.customer_groups
  for insert with check (public.is_owner());
drop policy if exists "customer_groups_update_owner" on public.customer_groups;
create policy "customer_groups_update_owner" on public.customer_groups
  for update using (public.is_owner())
  with check (public.is_owner());
drop policy if exists "customer_groups_delete_owner" on public.customer_groups;
create policy "customer_groups_delete_owner" on public.customer_groups
  for delete using (public.is_owner());

alter table public.product_customer_group_prices enable row level security;
drop policy if exists "product_customer_group_prices_select_auth" on public.product_customer_group_prices;
create policy "product_customer_group_prices_select_auth" on public.product_customer_group_prices
  for select using (auth.uid() is not null);
drop policy if exists "product_customer_group_prices_owner" on public.product_customer_group_prices;
create policy "product_customer_group_prices_owner" on public.product_customer_group_prices
  for all using (public.is_owner())
  with check (public.is_owner());

alter table public.product_presentation_prices enable row level security;
drop policy if exists "product_presentation_prices_select_auth" on public.product_presentation_prices;
create policy "product_presentation_prices_select_auth" on public.product_presentation_prices
  for select using (auth.uid() is not null);
drop policy if exists "product_presentation_prices_owner" on public.product_presentation_prices;
create policy "product_presentation_prices_owner" on public.product_presentation_prices
  for all using (public.is_owner())
  with check (public.is_owner());

alter table public.product_wholesale_tiers enable row level security;
drop policy if exists "product_wholesale_tiers_select_auth" on public.product_wholesale_tiers;
create policy "product_wholesale_tiers_select_auth" on public.product_wholesale_tiers
  for select using (auth.uid() is not null);
drop policy if exists "product_wholesale_tiers_owner" on public.product_wholesale_tiers;
create policy "product_wholesale_tiers_owner" on public.product_wholesale_tiers
  for all using (public.is_owner())
  with check (public.is_owner());

alter table public.product_promotions enable row level security;
drop policy if exists "product_promotions_select_auth" on public.product_promotions;
create policy "product_promotions_select_auth" on public.product_promotions
  for select using (auth.uid() is not null);
drop policy if exists "product_promotions_owner" on public.product_promotions;
create policy "product_promotions_owner" on public.product_promotions
  for all using (public.is_owner())
  with check (public.is_owner());
