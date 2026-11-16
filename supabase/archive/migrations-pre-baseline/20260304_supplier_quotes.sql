create table if not exists public.supplier_quotes (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers on delete restrict,
  min_required_units integer not null default 12,
  status text not null default 'draft' check (status in ('draft', 'sent', 'approved', 'rejected', 'cancelled')),
  notes text,
  total_items integer not null default 0,
  total_units numeric(12,3) not null default 0,
  total_cost numeric(14,2) not null default 0,
  created_by uuid references public.profiles on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.supplier_quote_items (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.supplier_quotes on delete cascade,
  product_id uuid not null references public.products on delete restrict,
  qty numeric(12,3) not null check (qty > 0),
  suggested_qty numeric(12,3) not null default 0,
  unit_name text not null default 'unidad',
  cost_unit numeric(12,4) not null default 0 check (cost_unit >= 0),
  line_total numeric(14,2) not null default 0 check (line_total >= 0),
  product_snapshot_name text,
  product_snapshot_sku text,
  created_at timestamptz not null default now()
);

create index if not exists idx_supplier_quotes_supplier_created_at
  on public.supplier_quotes (supplier_id, created_at desc);

create index if not exists idx_supplier_quote_items_quote
  on public.supplier_quote_items (quote_id);

create index if not exists idx_supplier_quote_items_product
  on public.supplier_quote_items (product_id);

alter table public.supplier_quotes enable row level security;
drop policy if exists "supplier_quotes_all_auth" on public.supplier_quotes;
create policy "supplier_quotes_all_auth" on public.supplier_quotes
  for all using (auth.uid() is not null)
  with check (auth.uid() is not null);

alter table public.supplier_quote_items enable row level security;
drop policy if exists "supplier_quote_items_all_auth" on public.supplier_quote_items;
create policy "supplier_quote_items_all_auth" on public.supplier_quote_items
  for all using (auth.uid() is not null)
  with check (auth.uid() is not null);
