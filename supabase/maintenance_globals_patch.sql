-- Patch incremental: módulo de mantenimiento (variables globales)
-- Ejecutar en Supabase SQL Editor

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

create or replace function public.normalize_uom_code(p_value text)
returns text
language sql
immutable
as $$
  select lower(trim(coalesce(p_value, '')));
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

update public.sales
set payment_method = coalesce(public.resolve_payment_method_code(payment_method), 'efectivo')
where coalesce(trim(payment_method), '') <> '';

drop trigger if exists trg_sales_payment_method_guard on public.sales;
create trigger trg_sales_payment_method_guard
before insert or update of payment_method on public.sales
for each row
execute function public.sales_payment_method_guard();

grant execute on function public.resolve_payment_method_code(text) to authenticated;
grant select on public.uom_catalog to authenticated;
grant select on public.payment_method_catalog to authenticated;
grant select on public.customer_groups to authenticated;

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
