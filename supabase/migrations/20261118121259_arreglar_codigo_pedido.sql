-- Crear pedidos fallaba: create_sales_order fija search_path = public y pgcrypto vive en el schema
-- "extensions", así que gen_random_bytes() no se encontraba. Se califica el nombre completo.
CREATE OR REPLACE FUNCTION "public"."generate_sales_order_code"() RETURNS "text"
    LANGUAGE "sql"
    AS $$
  select
    'PED-'
    || to_char(now(), 'YYYYMMDD-HH24MISS')
    || '-'
    || upper(substr(encode(extensions.gen_random_bytes(2), 'hex'), 1, 4));
$$;
