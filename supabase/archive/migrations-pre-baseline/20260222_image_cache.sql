-- Crear tabla para caché de imágenes analizadas por IA
create table if not exists public.image_cache (
  hash text primary key, -- MD5 o SHA256 de la imagen
  response_json jsonb not null, -- Respuesta estructurada de OpenAI
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- RLS (Row Level Security)
alter table public.image_cache enable row level security;

-- Permitir lectura y escritura a usuarios autenticados y anónimos (para el backend usando service role no aplica, pero buena práctica)
create policy "Allow read for all users" on public.image_cache for select using (true);
create policy "Allow insert for all users" on public.image_cache for insert with check (true);
create policy "Allow update for all users" on public.image_cache for update using (true);
