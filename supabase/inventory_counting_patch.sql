-- Patch: sesiones de conteo fisico de inventario
-- Ejecutar una sola vez en Supabase SQL Editor

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
