-- Crear tabla para caché de RAG matchings
create table if not exists public.match_cache (
  hash text primary key, -- Hash SHA256 del array de items JSON de entrada
  response_json jsonb not null, -- Respuesta estructurada final con matched items
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- RLS (Row Level Security)
alter table public.match_cache enable row level security;

-- Permitir lectura y escritura a todos (el backend usa policies normales/service role)
create policy "Allow read for all users" on public.match_cache for select using (true);
create policy "Allow insert for all users" on public.match_cache for insert with check (true);
create policy "Allow update for all users" on public.match_cache for update using (true);
