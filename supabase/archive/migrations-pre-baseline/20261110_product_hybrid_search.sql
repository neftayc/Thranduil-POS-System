-- Búsqueda híbrida de productos para el agente de ventas (agente 1).
--
--  * product_search_index: un texto y un vector por producto (nombre + marca + categoría + sinónimos).
--    NO contiene precio ni stock: esos datos se leen siempre en vivo.
--  * product_search_synonyms: frases aprendidas («markin 100 a4» → producto). La etapa 2 la
--    alimentará al validar las ventas por confirmar; se incluyen en el índice.
--  * search_products_hybrid(): candidatos combinando con RRF trigramas/palabras (pg_trgm + unaccent,
--    con OR, no AND) y similitud vectorial (pgvector). La decisión final (atributos exactos,
--    nivel de seguridad) la toma el código del agente.
--
-- Los triggers mantienen el texto al día al crear/editar productos, categorías o sinónimos y marcan
-- el vector como pendiente (embedded_hash <> content_hash). El vector lo calcula
-- `node scripts/index-product-search.mjs` o, en segundo plano, el propio POS al buscar.

create extension if not exists vector with schema extensions;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists unaccent with schema extensions;
-- Las extensiones pueden estar en `extensions` (Supabase) o en `public` (instalaciones antiguas).
-- `extensions` va primero para que nadie pueda suplantar sus funciones/operadores creando objetos en `public`.
set search_path = extensions, public;

-- Normalización inmutable (minúsculas, sin tildes, «#» = cuadriculado) usable en índices.
create or replace function public.search_normalize(p_value text)
returns text
language sql
immutable
parallel safe
set search_path = extensions, public, pg_temp
as $$
  select trim(regexp_replace(
    regexp_replace(
      lower(unaccent('unaccent'::regdictionary, replace(coalesce(p_value, ''), '#', ' cuadriculado '))),
      '[^a-z0-9.x ]+', ' ', 'g'),
    '\s+', ' ', 'g'))
$$;

create table if not exists public.product_search_synonyms (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  phrase text not null check (char_length(trim(phrase)) between 2 and 200),
  phrase_norm text generated always as (public.search_normalize(phrase)) stored,
  source text not null default 'manual' check (source in ('manual', 'sale_review', 'import')),
  hits integer not null default 0,
  active boolean not null default true,
  created_by uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_id, phrase_norm)
);
create index if not exists idx_product_search_synonyms_phrase on public.product_search_synonyms (phrase_norm) where active;

create table if not exists public.product_search_index (
  product_id uuid primary key references public.products(id) on delete cascade,
  document text not null,                -- texto legible que se envía al modelo de embeddings
  search_text text not null,             -- document normalizado (búsqueda por texto)
  content_hash text not null,            -- md5(document)
  embedding vector(1536),
  embedding_model text,
  embedded_hash text,                    -- content_hash con el que se calculó el vector
  embedded_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists idx_product_search_index_trgm on public.product_search_index using gin (search_text gin_trgm_ops);
create index if not exists idx_product_search_index_embedding on public.product_search_index using hnsw (embedding vector_cosine_ops);

alter table public.product_search_index enable row level security;
alter table public.product_search_synonyms enable row level security;
-- Solo el backend (service role) escribe. Los usuarios autenticados del POS pueden leer los sinónimos.
drop policy if exists "product_search_synonyms_read" on public.product_search_synonyms;
create policy "product_search_synonyms_read" on public.product_search_synonyms for select to authenticated using (true);

create or replace function public.refresh_product_search_index(p_product_id uuid)
returns void
language plpgsql
security definer
set search_path = extensions, public, pg_temp
as $$
declare
  v_doc text;
begin
  select concat_ws('. ',
           nullif(trim(p.name), ''),
           case when nullif(trim(p.brand), '') is not null then 'Marca: ' || regexp_replace(trim(p.brand), ',+$', '') end,
           case when coalesce(c.name, nullif(trim(p.product_type), '')) is not null then 'Categoría: ' || coalesce(c.name, trim(p.product_type)) end,
           case when s.phrases is not null then 'También: ' || s.phrases end)
    into v_doc
    from public.products p
    left join public.product_categories c on c.id = p.category_id
    left join lateral (
      select string_agg(ps.phrase, '; ' order by ps.created_at) as phrases
      from public.product_search_synonyms ps
      where ps.product_id = p.id and ps.active
    ) s on true
   where p.id = p_product_id and p.active = true;

  if v_doc is null then
    delete from public.product_search_index where product_id = p_product_id;
    return;
  end if;

  insert into public.product_search_index (product_id, document, search_text, content_hash, updated_at)
  values (p_product_id, v_doc, public.search_normalize(v_doc), md5(v_doc), now())
  on conflict (product_id) do update
    set document = excluded.document,
        search_text = excluded.search_text,
        content_hash = excluded.content_hash,
        updated_at = now()
    where product_search_index.content_hash is distinct from excluded.content_hash;
end;
$$;

create or replace function public.trg_products_search_index()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.refresh_product_search_index(new.id);
  return new;
end;
$$;
drop trigger if exists trg_products_search_index on public.products;
create trigger trg_products_search_index
after insert or update of name, brand, product_type, category_id, active on public.products
for each row execute function public.trg_products_search_index();

create or replace function public.trg_synonyms_search_index()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then perform public.refresh_product_search_index(old.product_id); end if;
  if tg_op in ('INSERT', 'UPDATE') then perform public.refresh_product_search_index(new.product_id); end if;
  return null;
end;
$$;
drop trigger if exists trg_synonyms_search_index on public.product_search_synonyms;
create trigger trg_synonyms_search_index
after insert or update or delete on public.product_search_synonyms
for each row execute function public.trg_synonyms_search_index();

create or replace function public.trg_categories_search_index()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.refresh_product_search_index(p.id) from public.products p where p.category_id = new.id;
  return null;
end;
$$;
drop trigger if exists trg_categories_search_index on public.product_categories;
create trigger trg_categories_search_index
after update of name on public.product_categories
for each row execute function public.trg_categories_search_index();

-- Vectores pendientes (producto nuevo/editado o cambio de modelo), para el indexador.
create or replace function public.product_search_pending(p_model text, p_limit integer default 200, p_all boolean default false)
returns table (product_id uuid, document text, content_hash text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select i.product_id, i.document, i.content_hash
    from public.product_search_index i
   where p_all
      or i.embedding is null
      or i.embedded_hash is distinct from i.content_hash
      or i.embedding_model is distinct from p_model
   order by i.updated_at
   limit least(greatest(coalesce(p_limit, 200), 1), 1000)
$$;

create or replace function public.search_products_hybrid(
  p_query text,
  p_query_embedding vector(1536) default null,
  p_match_count integer default 40
)
returns table (
  product_id uuid,
  name text,
  sku text,
  brand text,
  category text,
  synonyms text[],
  lexical_rank integer,
  vector_rank integer,
  vector_similarity double precision,
  rrf_score double precision
)
language sql
stable
security definer
set search_path = extensions, public, pg_temp
as $$
  with q as (
    select public.search_normalize(left(coalesce(p_query, ''), 500)) as text,
           least(greatest(coalesce(p_match_count, 40), 1), 100) as n
  ),
  terms as (
    select distinct t
      from q, regexp_split_to_table(q.text, ' ') as t
     where char_length(t) >= 2
       and t not in ('de', 'del', 'el', 'la', 'los', 'las', 'un', 'una', 'con', 'para', 'y', 'en', 'por', 'vender', 'venta')
  ),
  lexical as (
    select scored.product_id,
           row_number() over (order by scored.score desc, scored.product_id)::integer as rank
      from (
        select i.product_id,
               (select count(*) from terms
                 where i.search_text like '%' || terms.t || '%'
                    or (char_length(terms.t) >= 4 and terms.t <% i.search_text))::double precision
                 / greatest((select count(*) from terms), 1)
               + 0.5 * word_similarity(q.text, i.search_text) as score
          from public.product_search_index i, q
      ) scored
     where scored.score > 0.15
     order by scored.score desc
     limit (select n from q)
  ),
  semantic as (
    select i.product_id,
           row_number() over (order by i.embedding <=> p_query_embedding)::integer as rank,
           1 - (i.embedding <=> p_query_embedding) as similarity
      from public.product_search_index i
     where p_query_embedding is not null and i.embedding is not null
     order by i.embedding <=> p_query_embedding
     limit (select n from q)
  ),
  fused as (
    select coalesce(l.product_id, s.product_id) as product_id,
           l.rank as lexical_rank,
           s.rank as vector_rank,
           s.similarity as vector_similarity,
           coalesce(1.0 / (60 + l.rank), 0) + coalesce(1.0 / (60 + s.rank), 0) as rrf_score
      from lexical l
      full outer join semantic s on s.product_id = l.product_id
  )
  select f.product_id, p.name, p.sku, p.brand, coalesce(c.name, p.product_type) as category,
         coalesce((select array_agg(ps.phrase order by ps.created_at)
                     from public.product_search_synonyms ps
                    where ps.product_id = p.id and ps.active), array[]::text[]) as synonyms,
         f.lexical_rank, f.vector_rank, f.vector_similarity, f.rrf_score
    from fused f
    join public.products p on p.id = f.product_id and p.active = true
    left join public.product_categories c on c.id = p.category_id
   order by f.rrf_score desc
   limit (select n from q)
$$;

revoke all on function public.search_products_hybrid(text, vector, integer) from public, anon, authenticated;
revoke all on function public.product_search_pending(text, integer, boolean) from public, anon, authenticated;
revoke all on function public.refresh_product_search_index(uuid) from public, anon, authenticated;
-- Solo el backend del POS (service role) consulta la búsqueda; no se expone a usuarios autenticados.
grant execute on function public.search_products_hybrid(text, vector, integer) to service_role;
grant execute on function public.product_search_pending(text, integer, boolean) to service_role;
grant execute on function public.refresh_product_search_index(uuid) to service_role;

-- Carga inicial del texto (los vectores se calculan con el script de indexado).
do $$
begin
  perform public.refresh_product_search_index(p.id) from public.products p where p.active = true;
end $$;
