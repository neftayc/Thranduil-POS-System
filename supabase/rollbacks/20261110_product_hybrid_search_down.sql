-- Rollback de 20261110_product_hybrid_search.sql (búsqueda híbrida del agente de ventas).
-- Solo elimina objetos creados por esa migración; no toca products, precios, stock ni ventas.
-- Las extensiones (vector, pg_trgm, unaccent) se conservan: otras partes del POS pueden usarlas
-- (p. ej. products.embedding de 20260222_pgvector_products.sql).
-- Sin los objetos, el agente vuelve solo a la búsqueda léxica en memoria (sigue funcionando).

begin;
drop trigger if exists trg_products_search_index on public.products;
drop trigger if exists trg_categories_search_index on public.product_categories;
drop trigger if exists trg_synonyms_search_index on public.product_search_synonyms;
drop function if exists public.search_products_hybrid(text, vector, integer);
drop function if exists public.product_search_pending(text, integer, boolean);
drop function if exists public.trg_products_search_index();
drop function if exists public.trg_categories_search_index();
drop function if exists public.trg_synonyms_search_index();
drop function if exists public.refresh_product_search_index(uuid);
drop table if exists public.product_search_index;
-- Los sinónimos aprendidos se pierden al borrar esta tabla: expórtala antes si ya tiene datos.
drop table if exists public.product_search_synonyms;
drop function if exists public.search_normalize(text);
commit;
