-- Persistencia de configuración de combos por usuario
create table if not exists public.combo_workspaces (
  user_id uuid primary key references auth.users(id) on delete cascade,
  combos jsonb not null default '[]'::jsonb check (jsonb_typeof(combos) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.combo_workspaces enable row level security;

drop policy if exists "combo_workspaces_select_own" on public.combo_workspaces;
create policy "combo_workspaces_select_own"
  on public.combo_workspaces for select
  using (auth.uid() = user_id);

drop policy if exists "combo_workspaces_insert_own" on public.combo_workspaces;
create policy "combo_workspaces_insert_own"
  on public.combo_workspaces for insert
  with check (auth.uid() = user_id);

drop policy if exists "combo_workspaces_update_own" on public.combo_workspaces;
create policy "combo_workspaces_update_own"
  on public.combo_workspaces for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "combo_workspaces_delete_own" on public.combo_workspaces;
create policy "combo_workspaces_delete_own"
  on public.combo_workspaces for delete
  using (auth.uid() = user_id);

grant select, insert, update, delete on public.combo_workspaces to authenticated;
