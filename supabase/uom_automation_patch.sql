-- Patch: conversión automática por unidades de medida
-- Ejecutar en Supabase SQL Editor (una sola vez)

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

alter table public.purchase_items add column if not exists unit_name text not null default 'unidad';
alter table public.purchase_items add column if not exists qty_uom numeric(12,3) not null default 0;
alter table public.purchase_items add column if not exists factor_to_base numeric(12,6) not null default 1;
alter table public.purchase_items add column if not exists cost_unit_uom numeric(12,4) not null default 0;

alter table public.sale_items add column if not exists unit_name text not null default 'unidad';
alter table public.sale_items add column if not exists qty_uom numeric(12,3) not null default 0;
alter table public.sale_items add column if not exists factor_to_base numeric(12,6) not null default 1;
alter table public.sale_items add column if not exists price_unit_uom numeric(12,4) not null default 0;
alter table public.sale_items alter column price_unit type numeric(12,4);

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
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'Items invalidos';
  end if;

  insert into public.sales (customer_id, payment_method, created_by, total)
  values (p_customer_id, p_payment_method, auth.uid(), 0)
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

grant execute on function public.resolve_product_uom_factor(uuid, text) to authenticated;
grant execute on function public.replace_product_unit_conversions(uuid, jsonb) to authenticated;
grant execute on function public.resolve_uom_code(text) to authenticated;
grant execute on function public.resolve_payment_method_code(text) to authenticated;
grant execute on function public.create_purchase(uuid, text, jsonb) to authenticated;
grant execute on function public.create_sale(uuid, text, jsonb) to authenticated;
grant select on public.uom_catalog to authenticated;
grant select on public.payment_method_catalog to authenticated;

alter table public.product_unit_conversions enable row level security;
drop policy if exists "product_unit_conversions_all_auth" on public.product_unit_conversions;
create policy "product_unit_conversions_all_auth" on public.product_unit_conversions
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
