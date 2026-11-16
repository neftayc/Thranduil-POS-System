-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query)

-- 1. Enable pgvector extension
create extension if not exists vector;

-- 2. Add embedding column to products table (text-embedding-3-small = 1536 dims)
alter table products
  add column if not exists embedding vector(1536);

-- 3. Create index for fast similarity search (cosine distance)
create index if not exists products_embedding_idx
  on products
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 50);

-- 4. Create similarity search function
create or replace function match_products(
  query_embedding  vector(1536),
  match_threshold  float   default 0.3,
  match_count      int     default 5
)
returns table (
  id              uuid,
  sku             text,
  name            text,
  unit            text,
  sale_price      numeric,
  stock_on_hand   numeric,
  similarity      float
)
language sql stable
as $$
  select
    p.id,
    p.sku,
    p.name,
    p.unit,
    p.sale_price,
    p.stock_on_hand,
    1 - (p.embedding <=> query_embedding) as similarity
  from products p
  where
    p.active = true
    and p.embedding is not null
    and 1 - (p.embedding <=> query_embedding) > match_threshold
  order by p.embedding <=> query_embedding
  limit match_count;
$$;
