


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pg_trgm" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "unaccent" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "vector" WITH SCHEMA "public";






CREATE OR REPLACE FUNCTION "public"."create_purchase"("p_supplier_id" "uuid", "p_invoice_no" "text", "p_items" "jsonb") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_purchase_id uuid;
  v_purchase_item_id uuid;
  v_item jsonb;
  v_product_id uuid;
  v_qty_input numeric;
  v_cost_input numeric;
  v_qty_base numeric;
  v_cost_base numeric;
  v_unit_name text;
  v_base_unit text;
  v_factor numeric;
  v_old_stock numeric;
  v_old_avg numeric;
  v_min_stock numeric;
  v_new_stock numeric;
  v_new_avg numeric;
  v_total numeric := 0;
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'Items invalidos';
  end if;

  insert into public.purchases (supplier_id, invoice_no, created_by, total_cost)
  values (p_supplier_id, p_invoice_no, auth.uid(), 0)
  returning id into v_purchase_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_product_id := (v_item->>'product_id')::uuid;
    v_qty_input := coalesce(nullif(v_item->>'qty', '')::numeric, 0);
    v_cost_input := coalesce(nullif(v_item->>'cost_unit', '')::numeric, 0);

    if v_qty_input <= 0 then
      raise exception 'Cantidad invalida';
    end if;

    if v_cost_input < 0 then
      raise exception 'Costo invalido';
    end if;

    select coalesce(nullif(trim(unit), ''), 'unidad')
      into v_base_unit
      from public.products
      where id = v_product_id;

    if v_base_unit is null then
      raise exception 'Producto no encontrado';
    end if;

    v_base_unit := public.require_uom_code(v_base_unit);
    if coalesce(trim(v_item->>'unit_name'), '') = '' then
      v_unit_name := v_base_unit;
    else
      v_unit_name := public.require_uom_code(v_item->>'unit_name');
    end if;
    v_factor := public.resolve_product_uom_factor(v_product_id, v_unit_name);
    v_qty_base := v_qty_input * v_factor;

    if v_qty_base <= 0 then
      raise exception 'Cantidad base invalida';
    end if;

    v_cost_base := v_cost_input / v_factor;

    insert into public.inventory_balances (product_id, stock_on_hand, avg_cost, min_stock, updated_at)
    values (
      v_product_id,
      0,
      0,
      coalesce((select p.min_stock from public.products p where p.id = v_product_id), 0),
      now()
    )
    on conflict (product_id) do nothing;

    select stock_on_hand, avg_cost, min_stock
      into v_old_stock, v_old_avg, v_min_stock
      from public.inventory_balances
      where product_id = v_product_id
      for update;

    v_new_stock := v_old_stock + v_qty_base;
    if v_new_stock = 0 then
      v_new_avg := 0;
    else
      v_new_avg := ((v_old_stock * v_old_avg) + (v_qty_base * v_cost_base)) / v_new_stock;
    end if;

    update public.inventory_balances
      set stock_on_hand = v_new_stock,
          avg_cost = v_new_avg,
          updated_at = now()
      where product_id = v_product_id;

    update public.products
      set stock_on_hand = v_new_stock,
          avg_cost = v_new_avg,
          min_stock = coalesce(v_min_stock, min_stock),
          updated_at = now()
      where id = v_product_id;

    insert into public.purchase_items (
      purchase_id,
      product_id,
      unit_name,
      qty_uom,
      factor_to_base,
      cost_unit_uom,
      qty,
      cost_unit,
      total_cost
    )
    values (
      v_purchase_id,
      v_product_id,
      v_unit_name,
      v_qty_input,
      v_factor,
      v_cost_input,
      v_qty_base,
      v_cost_base,
      v_qty_input * v_cost_input
    )
    returning id into v_purchase_item_id;

    insert into public.stock_cost_layers (
      product_id,
      purchase_id,
      purchase_item_id,
      source,
      layer_date,
      qty_in,
      qty_remaining,
      cost_unit,
      created_by
    )
    values (
      v_product_id,
      v_purchase_id,
      v_purchase_item_id,
      'purchase',
      coalesce((select p.purchase_date from public.purchases p where p.id = v_purchase_id), now()),
      v_qty_base,
      v_qty_base,
      v_cost_base,
      auth.uid()
    );

    insert into public.stock_movements (product_id, movement_type, qty, cost_unit, ref_table, ref_id, created_by)
    values (v_product_id, 'purchase', v_qty_base, v_cost_base, 'purchases', v_purchase_id, auth.uid());

    v_total := v_total + (v_qty_input * v_cost_input);
  end loop;

  update public.purchases
    set total_cost = v_total
    where id = v_purchase_id;

  return v_purchase_id;
end;
$$;


ALTER FUNCTION "public"."create_purchase"("p_supplier_id" "uuid", "p_invoice_no" "text", "p_items" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_sale"("p_customer_id" "uuid", "p_payment_method" "text", "p_items" "jsonb", "p_sold_by" "uuid" DEFAULT NULL::"uuid", "p_approved_by" "uuid" DEFAULT NULL::"uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_sale_id uuid;
  v_item jsonb;
  v_product_id uuid;
  v_qty_input numeric;
  v_price_input numeric;
  v_qty_base numeric;
  v_price_base numeric;
  v_unit_name text;
  v_base_unit text;
  v_factor numeric;
  v_old_stock numeric;
  v_old_avg numeric;
  v_min_stock numeric;
  v_product_name text;
  v_total numeric := 0;
  v_payment_method_code text;
  v_pricing jsonb;
  v_auto_price_uom numeric;
  v_final_price_uom numeric;
  v_manual_discount_pct numeric;
  v_manual_discount_amount numeric;
  v_manual_discount_reason text;
  v_role text;
  v_can_manual_discount boolean := false;
  v_sale_item_id uuid;
  v_fifo_remaining numeric;
  v_fifo_take numeric;
  v_fifo_cost_total numeric;
  v_sale_cost_unit numeric;
  v_layer record;
  v_layer_fallback_id uuid;
  v_alloc jsonb;
  v_alloc_item jsonb;
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'Items invalidos';
  end if;

  v_payment_method_code := coalesce(public.resolve_payment_method_code(p_payment_method), 'efectivo');
  v_role := coalesce(public.user_role(), 'cashier');
  v_can_manual_discount := v_role in ('owner', 'manager');

  -- Atribución (opcional). Sin p_sold_by la venta es de quien la registra (auth.uid()), como siempre.
  if p_sold_by is not null then
    if not exists (
      select 1
        from public.profiles pr
        join auth.users u on u.id = pr.id
       where pr.id = p_sold_by
         and u.deleted_at is null
         and (u.banned_until is null or u.banned_until <= now())
    ) then
      raise exception 'Vendedor no valido o inactivo';
    end if;
    if p_sold_by <> auth.uid() and v_role not in ('owner', 'manager') then
      raise exception 'Tu rol no permite registrar ventas a nombre de otro vendedor';
    end if;
  end if;
  -- Quien aprueba es siempre el usuario autenticado, y solo propietario o encargado.
  if p_approved_by is not null then
    if p_approved_by <> auth.uid() then
      raise exception 'approved_by debe ser el usuario que aprueba';
    end if;
    if v_role not in ('owner', 'manager') then
      raise exception 'Tu rol no permite aprobar ventas';
    end if;
  end if;

  insert into public.sales (customer_id, payment_method, created_by, sold_by, approved_by, total)
  values (p_customer_id, v_payment_method_code, auth.uid(), coalesce(p_sold_by, auth.uid()), p_approved_by, 0)
  returning id into v_sale_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_product_id := (v_item->>'product_id')::uuid;
    v_qty_input := coalesce(nullif(v_item->>'qty', '')::numeric, 0);
    v_price_input := nullif(v_item->>'price_unit', '')::numeric;
    v_manual_discount_pct := greatest(coalesce(nullif(v_item->>'manual_discount_pct', '')::numeric, 0), 0);
    v_manual_discount_amount := greatest(coalesce(nullif(v_item->>'manual_discount_amount', '')::numeric, 0), 0);
    v_manual_discount_reason := nullif(trim(coalesce(v_item->>'manual_discount_reason', '')), '');

    if v_qty_input <= 0 then
      raise exception 'Cantidad invalida';
    end if;

    if v_price_input is not null and v_price_input < 0 then
      raise exception 'Precio invalido';
    end if;

    select coalesce(nullif(trim(unit), ''), 'unidad')
      into v_base_unit
      from public.products
      where id = v_product_id;

    if v_base_unit is null then
      raise exception 'Producto no encontrado';
    end if;

    v_base_unit := public.require_uom_code(v_base_unit);
    if coalesce(trim(v_item->>'unit_name'), '') = '' then
      v_unit_name := v_base_unit;
    else
      v_unit_name := public.require_uom_code(v_item->>'unit_name');
    end if;

    v_pricing := public.resolve_sale_item_pricing(
      p_product_id := v_product_id,
      p_unit_name := v_unit_name,
      p_qty_uom := v_qty_input,
      p_customer_id := p_customer_id,
      p_sale_at := now()
    );

    v_factor := coalesce((v_pricing->>'factor')::numeric, 1);
    v_qty_base := coalesce((v_pricing->>'qty_base')::numeric, v_qty_input * v_factor);
    v_auto_price_uom := coalesce((v_pricing->>'price_uom')::numeric, 0);
    v_final_price_uom := v_auto_price_uom;

    if (
      v_manual_discount_pct > 0
      or v_manual_discount_amount > 0
      or (v_price_input is not null and abs(v_price_input - v_auto_price_uom) > 0.0001)
    ) then
      if not v_can_manual_discount then
        raise exception 'Tu rol no permite descuento o ajuste manual de precio';
      end if;
      if v_manual_discount_reason is null then
        raise exception 'Motivo obligatorio para descuento o ajuste manual';
      end if;
    end if;

    if v_manual_discount_pct > 0 then
      v_final_price_uom := v_final_price_uom * (1 - (v_manual_discount_pct / 100));
    end if;

    if v_manual_discount_amount > 0 then
      v_final_price_uom := v_final_price_uom - v_manual_discount_amount;
    end if;

    if v_price_input is not null and abs(v_price_input - v_auto_price_uom) > 0.0001 then
      v_final_price_uom := v_price_input;
    end if;

    v_final_price_uom := round(v_final_price_uom::numeric, 4);
    if v_final_price_uom < 0 then
      raise exception 'Precio final inválido para %', v_product_id;
    end if;

    v_price_base := case when v_factor = 0 then 0 else round((v_final_price_uom / v_factor)::numeric, 4) end;

    insert into public.inventory_balances (product_id, stock_on_hand, avg_cost, min_stock, updated_at)
    values (
      v_product_id,
      coalesce((select p.stock_on_hand from public.products p where p.id = v_product_id), 0),
      coalesce((select p.avg_cost from public.products p where p.id = v_product_id), 0),
      coalesce((select p.min_stock from public.products p where p.id = v_product_id), 0),
      now()
    )
    on conflict (product_id) do nothing;

    select ib.stock_on_hand, ib.avg_cost, ib.min_stock, p.name
      into v_old_stock, v_old_avg, v_min_stock, v_product_name
      from public.inventory_balances ib
      join public.products p on p.id = ib.product_id
      where ib.product_id = v_product_id
      for update;

    if v_old_stock < v_qty_base then
      raise exception 'Stock insuficiente para %', v_product_name;
    end if;

    v_fifo_remaining := v_qty_base;
    v_fifo_cost_total := 0;
    v_alloc := '[]'::jsonb;

    for v_layer in
      select
        scl.id,
        scl.qty_remaining,
        scl.cost_unit
      from public.stock_cost_layers scl
      where scl.product_id = v_product_id
        and scl.qty_remaining > 0
      order by scl.layer_date asc, scl.fifo_order asc
      for update
    loop
      exit when v_fifo_remaining <= 0;

      v_fifo_take := least(v_fifo_remaining, v_layer.qty_remaining);
      if v_fifo_take <= 0 then
        continue;
      end if;

      update public.stock_cost_layers
      set qty_remaining = qty_remaining - v_fifo_take,
          updated_at = now()
      where id = v_layer.id;

      v_fifo_cost_total := v_fifo_cost_total + (v_fifo_take * v_layer.cost_unit);
      v_fifo_remaining := v_fifo_remaining - v_fifo_take;

      v_alloc := v_alloc || jsonb_build_array(
        jsonb_build_object(
          'layer_id', v_layer.id,
          'qty', v_fifo_take,
          'cost_unit', v_layer.cost_unit
        )
      );
    end loop;

    if v_fifo_remaining > 0 then
      insert into public.stock_cost_layers (
        product_id,
        source,
        layer_date,
        qty_in,
        qty_remaining,
        cost_unit,
        note,
        created_by,
        updated_at
      )
      values (
        v_product_id,
        'auto-balance',
        now(),
        v_fifo_remaining,
        0,
        coalesce(v_old_avg, 0),
        'Capa automatica para cuadrar venta sin capas FIFO previas',
        auth.uid(),
        now()
      )
      returning id into v_layer_fallback_id;

      v_fifo_cost_total := v_fifo_cost_total + (v_fifo_remaining * coalesce(v_old_avg, 0));
      v_alloc := v_alloc || jsonb_build_array(
        jsonb_build_object(
          'layer_id', v_layer_fallback_id,
          'qty', v_fifo_remaining,
          'cost_unit', coalesce(v_old_avg, 0)
        )
      );
      v_fifo_remaining := 0;
    end if;

    v_sale_cost_unit := case
      when v_qty_base > 0 then round((v_fifo_cost_total / v_qty_base)::numeric, 4)
      else coalesce(v_old_avg, 0)
    end;

    update public.inventory_balances
      set stock_on_hand = v_old_stock - v_qty_base,
          updated_at = now()
      where product_id = v_product_id;

    update public.products
      set stock_on_hand = v_old_stock - v_qty_base,
          avg_cost = v_old_avg,
          min_stock = coalesce(v_min_stock, min_stock),
          updated_at = now()
      where id = v_product_id;

    insert into public.sale_items (
      sale_id,
      product_id,
      unit_name,
      qty_uom,
      factor_to_base,
      price_unit_uom,
      qty,
      price_unit,
      auto_price_unit,
      pricing_source,
      pricing_detail,
      manual_discount_pct,
      manual_discount_amount,
      manual_discount_reason,
      total
    )
    values (
      v_sale_id,
      v_product_id,
      v_unit_name,
      v_qty_input,
      v_factor,
      v_final_price_uom,
      v_qty_base,
      v_price_base,
      v_auto_price_uom,
      coalesce(v_pricing->>'source', 'base'),
      v_pricing,
      v_manual_discount_pct,
      v_manual_discount_amount,
      v_manual_discount_reason,
      v_qty_input * v_final_price_uom
    )
    returning id into v_sale_item_id;

    for v_alloc_item in
      select * from jsonb_array_elements(v_alloc)
    loop
      insert into public.sale_cost_allocations (
        sale_id,
        sale_item_id,
        product_id,
        layer_id,
        qty,
        cost_unit,
        total_cost,
        created_by
      )
      values (
        v_sale_id,
        v_sale_item_id,
        v_product_id,
        (v_alloc_item->>'layer_id')::uuid,
        coalesce((v_alloc_item->>'qty')::numeric, 0),
        coalesce((v_alloc_item->>'cost_unit')::numeric, 0),
        coalesce((v_alloc_item->>'qty')::numeric, 0) * coalesce((v_alloc_item->>'cost_unit')::numeric, 0),
        auth.uid()
      );
    end loop;

    insert into public.stock_movements (product_id, movement_type, qty, cost_unit, ref_table, ref_id, created_by)
    values (v_product_id, 'sale', -v_qty_base, v_sale_cost_unit, 'sales', v_sale_id, auth.uid());

    v_total := v_total + (v_qty_input * v_final_price_uom);
  end loop;

  update public.sales
    set total = v_total
    where id = v_sale_id;

  return v_sale_id;
end;
$$;


ALTER FUNCTION "public"."create_sale"("p_customer_id" "uuid", "p_payment_method" "text", "p_items" "jsonb", "p_sold_by" "uuid", "p_approved_by" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_sales_order"("p_customer_id" "uuid", "p_payment_method" "text", "p_items" "jsonb", "p_notes" "text" DEFAULT NULL::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_order_id uuid;
  v_item jsonb;
  v_product_id uuid;
  v_qty_input numeric;
  v_price_input numeric;
  v_unit_name text;
  v_base_unit text;
  v_factor numeric;
  v_line_total numeric;
  v_total numeric := 0;
  v_payment_method_code text;
  v_pricing jsonb;
  v_auto_price_uom numeric;
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'Items invalidos';
  end if;

  v_payment_method_code := coalesce(public.resolve_payment_method_code(p_payment_method), 'efectivo');

  insert into public.sales_orders (
    order_code,
    status,
    customer_id,
    payment_method,
    notes,
    total,
    created_by
  )
  values (
    public.generate_sales_order_code(),
    'open',
    p_customer_id,
    v_payment_method_code,
    nullif(trim(coalesce(p_notes, '')), ''),
    0,
    auth.uid()
  )
  returning id into v_order_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_product_id := (v_item->>'product_id')::uuid;
    v_qty_input := coalesce(nullif(v_item->>'qty', '')::numeric, 0);
    v_price_input := nullif(v_item->>'price_unit', '')::numeric;

    if v_qty_input <= 0 then
      raise exception 'Cantidad invalida';
    end if;

    select coalesce(nullif(trim(unit), ''), 'unidad')
      into v_base_unit
      from public.products
      where id = v_product_id;

    if v_base_unit is null then
      raise exception 'Producto no encontrado';
    end if;

    v_base_unit := public.require_uom_code(v_base_unit);
    if coalesce(trim(v_item->>'unit_name'), '') = '' then
      v_unit_name := v_base_unit;
    else
      v_unit_name := public.require_uom_code(v_item->>'unit_name');
    end if;

    v_factor := public.resolve_product_uom_factor(v_product_id, v_unit_name);

    v_pricing := public.resolve_sale_item_pricing(
      p_product_id := v_product_id,
      p_unit_name := v_unit_name,
      p_qty_uom := v_qty_input,
      p_customer_id := p_customer_id,
      p_sale_at := now()
    );

    v_auto_price_uom := coalesce((v_pricing->>'price_uom')::numeric, 0);
    if v_price_input is null then
      v_price_input := v_auto_price_uom;
    end if;

    if v_price_input < 0 then
      raise exception 'Precio invalido';
    end if;

    v_line_total := round((v_qty_input * v_price_input)::numeric, 2);
    v_total := v_total + v_line_total;

    insert into public.sales_order_items (
      order_id,
      product_id,
      unit_name,
      qty_uom,
      factor_to_base,
      auto_price_unit,
      price_unit_uom,
      pricing_source,
      pricing_detail,
      total
    )
    values (
      v_order_id,
      v_product_id,
      v_unit_name,
      v_qty_input,
      v_factor,
      v_auto_price_uom,
      v_price_input,
      coalesce(v_pricing->>'source', 'base'),
      v_pricing,
      v_line_total
    );
  end loop;

  update public.sales_orders
    set total = round(v_total::numeric, 2),
        updated_at = now()
    where id = v_order_id;

  return v_order_id;
end;
$$;


ALTER FUNCTION "public"."create_sales_order"("p_customer_id" "uuid", "p_payment_method" "text", "p_items" "jsonb", "p_notes" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."customer_group_for_sale"("p_customer_id" "uuid") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_group text;
begin
  if p_customer_id is null then
    return 'minorista';
  end if;

  select c.customer_group
    into v_group
    from public.customers c
    where c.id = p_customer_id
    limit 1;

  if v_group is null then
    return 'minorista';
  end if;

  if not exists (
    select 1
    from public.customer_groups g
    where g.code = v_group
      and g.active = true
  ) then
    return 'minorista';
  end if;

  return v_group;
end;
$$;


ALTER FUNCTION "public"."customer_group_for_sale"("p_customer_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."ensure_product_category"("p_name" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_name text;
  v_code text;
  v_id uuid;
  v_sort_order integer;
begin
  v_name := nullif(trim(p_name), '');
  if v_name is null then
    return null;
  end if;

  select c.id
    into v_id
    from public.product_categories c
    where public.normalize_uom_code(c.name) = public.normalize_uom_code(v_name)
    limit 1;

  if v_id is not null then
    return v_id;
  end if;

  v_code := public.normalize_category_code(v_name);
  if v_code = '' then
    v_code := 'cat_' || substr(md5(v_name || clock_timestamp()::text), 1, 12);
  end if;

  select c.id
    into v_id
    from public.product_categories c
    where c.code = v_code
    limit 1;

  if v_id is not null then
    return v_id;
  end if;

  select coalesce(max(c.sort_order), 0) + 10
    into v_sort_order
    from public.product_categories c;

  insert into public.product_categories (code, name, active, sort_order, updated_at)
  values (v_code, v_name, true, v_sort_order, now())
  on conflict (code) do update
    set name = excluded.name,
        updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;


ALTER FUNCTION "public"."ensure_product_category"("p_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generate_sales_order_code"() RETURNS "text"
    LANGUAGE "sql"
    AS $$
  select
    'PED-'
    || to_char(now(), 'YYYYMMDD-HH24MISS')
    || '-'
    || upper(substr(encode(gen_random_bytes(2), 'hex'), 1, 4));
$$;


ALTER FUNCTION "public"."generate_sales_order_code"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_count int;
begin
  select count(*) into v_count from public.profiles;

  insert into public.profiles (id, full_name, role)
  values (
    new.id,
    new.raw_user_meta_data->>'full_name',
    case when v_count = 0 then 'owner' else 'cashier' end
  );

  return new;
end;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_owner"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select coalesce(public.user_role() = 'owner', false);
$$;


ALTER FUNCTION "public"."is_owner"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."match_products"("query_embedding" "public"."vector", "match_threshold" double precision DEFAULT 0.3, "match_count" integer DEFAULT 5) RETURNS TABLE("id" "uuid", "sku" "text", "name" "text", "unit" "text", "sale_price" numeric, "stock_on_hand" numeric, "similarity" double precision)
    LANGUAGE "sql" STABLE
    AS $$
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


ALTER FUNCTION "public"."match_products"("query_embedding" "public"."vector", "match_threshold" double precision, "match_count" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."normalize_category_code"("p_value" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select trim(both '_' from regexp_replace(
    regexp_replace(public.normalize_uom_code(coalesce(p_value, '')), '\s+', '_', 'g'),
    '[^[:alnum:]_]+',
    '',
    'g'
  ));
$$;


ALTER FUNCTION "public"."normalize_category_code"("p_value" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."normalize_uom_code"("p_value" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select lower(trim(coalesce(p_value, '')));
$$;


ALTER FUNCTION "public"."normalize_uom_code"("p_value" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."pay_sales_order"("p_order_id" "uuid", "p_payment_method" "text" DEFAULT NULL::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_order record;
  v_item record;
  v_sale_id uuid;
  v_total numeric := 0;
  v_qty_base numeric;
  v_price_base numeric;
  v_old_stock numeric;
  v_old_avg numeric;
  v_min_stock numeric;
  v_payment_method_code text;
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  select *
    into v_order
    from public.sales_orders
    where id = p_order_id
      and status = 'open'
    for update;

  if v_order.id is null then
    raise exception 'Pedido no disponible para cobro';
  end if;

  v_payment_method_code := coalesce(
    public.resolve_payment_method_code(p_payment_method),
    public.resolve_payment_method_code(v_order.payment_method),
    'efectivo'
  );

  insert into public.sales (customer_id, payment_method, created_by, total)
  values (v_order.customer_id, v_payment_method_code, auth.uid(), 0)
  returning id into v_sale_id;

  for v_item in
    select
      oi.*,
      p.name as product_name
    from public.sales_order_items oi
    join public.products p on p.id = oi.product_id
    where oi.order_id = p_order_id
    order by oi.created_at, oi.id
  loop
    v_qty_base := v_item.qty_uom * v_item.factor_to_base;
    if v_qty_base <= 0 then
      raise exception 'Cantidad invalida en pedido';
    end if;

    v_price_base := case
      when v_item.factor_to_base = 0 then 0
      else round((v_item.price_unit_uom / v_item.factor_to_base)::numeric, 4)
    end;

    insert into public.inventory_balances (product_id, stock_on_hand, avg_cost, min_stock, updated_at)
    values (
      v_item.product_id,
      coalesce((select p.stock_on_hand from public.products p where p.id = v_item.product_id), 0),
      coalesce((select p.avg_cost from public.products p where p.id = v_item.product_id), 0),
      coalesce((select p.min_stock from public.products p where p.id = v_item.product_id), 0),
      now()
    )
    on conflict (product_id) do nothing;

    select ib.stock_on_hand, ib.avg_cost, ib.min_stock
      into v_old_stock, v_old_avg, v_min_stock
      from public.inventory_balances ib
      where ib.product_id = v_item.product_id
      for update;

    if v_old_stock < v_qty_base then
      raise exception 'Stock insuficiente para %', v_item.product_name;
    end if;

    update public.inventory_balances
      set stock_on_hand = v_old_stock - v_qty_base,
          updated_at = now()
      where product_id = v_item.product_id;

    update public.products
      set stock_on_hand = v_old_stock - v_qty_base,
          avg_cost = v_old_avg,
          min_stock = coalesce(v_min_stock, min_stock),
          updated_at = now()
      where id = v_item.product_id;

    insert into public.sale_items (
      sale_id,
      product_id,
      unit_name,
      qty_uom,
      factor_to_base,
      price_unit_uom,
      qty,
      price_unit,
      auto_price_unit,
      pricing_source,
      pricing_detail,
      manual_discount_pct,
      manual_discount_amount,
      manual_discount_reason,
      total
    )
    values (
      v_sale_id,
      v_item.product_id,
      v_item.unit_name,
      v_item.qty_uom,
      v_item.factor_to_base,
      v_item.price_unit_uom,
      v_qty_base,
      v_price_base,
      v_item.auto_price_unit,
      coalesce(v_item.pricing_source, 'pedido'),
      coalesce(v_item.pricing_detail, '{}'::jsonb),
      0,
      0,
      'Cobro de pedido',
      v_item.total
    );

    insert into public.stock_movements (product_id, movement_type, qty, cost_unit, ref_table, ref_id, created_by)
    values (v_item.product_id, 'sale', -v_qty_base, v_old_avg, 'sales', v_sale_id, auth.uid());

    v_total := v_total + v_item.total;
  end loop;

  update public.sales
    set total = round(v_total::numeric, 2)
    where id = v_sale_id;

  update public.sales_orders
    set status = 'paid',
        paid_sale_id = v_sale_id,
        paid_at = now(),
        payment_method = v_payment_method_code,
        updated_at = now()
    where id = p_order_id;

  return v_sale_id;
end;
$$;


ALTER FUNCTION "public"."pay_sales_order"("p_order_id" "uuid", "p_payment_method" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."product_search_pending"("p_model" "text", "p_limit" integer DEFAULT 200, "p_all" boolean DEFAULT false) RETURNS TABLE("product_id" "uuid", "document" "text", "content_hash" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select i.product_id, i.document, i.content_hash
    from public.product_search_index i
   where p_all
      or i.embedding is null
      or i.embedded_hash is distinct from i.content_hash
      or i.embedding_model is distinct from p_model
   order by i.updated_at
   limit least(greatest(coalesce(p_limit, 200), 1), 1000)
$$;


ALTER FUNCTION "public"."product_search_pending"("p_model" "text", "p_limit" integer, "p_all" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."products_category_guard"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_category_name text;
  v_category_id uuid;
begin
  if new.category_id is not null then
    select c.name
      into v_category_name
      from public.product_categories c
      where c.id = new.category_id
      limit 1;

    if v_category_name is null then
      raise exception 'Categoria inválida';
    end if;

    new.product_type := v_category_name;
    return new;
  end if;

  v_category_name := nullif(trim(new.product_type), '');
  if v_category_name is null then
    new.product_type := null;
    return new;
  end if;

  v_category_id := public.ensure_product_category(v_category_name);
  if v_category_id is not null then
    new.category_id := v_category_id;
    select c.name
      into v_category_name
      from public.product_categories c
      where c.id = v_category_id
      limit 1;
    if v_category_name is not null then
      new.product_type := v_category_name;
    end if;
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."products_category_guard"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."products_unit_guard"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  new.unit := public.require_uom_code(coalesce(new.unit, 'unidad'));
  return new;
end;
$$;


ALTER FUNCTION "public"."products_unit_guard"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."purchase_items_sync_base_fields"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_base_unit text;
  v_unit_name text;
  v_factor numeric;
  v_qty_uom numeric;
  v_cost_uom numeric;
begin
  if new.product_id is null then
    raise exception 'Producto no encontrado';
  end if;

  select coalesce(nullif(trim(unit), ''), 'unidad')
    into v_base_unit
    from public.products
    where id = new.product_id
    limit 1;

  if v_base_unit is null then
    raise exception 'Producto no encontrado';
  end if;

  v_base_unit := public.require_uom_code(v_base_unit);
  if coalesce(trim(new.unit_name), '') = '' then
    v_unit_name := v_base_unit;
  else
    v_unit_name := public.require_uom_code(new.unit_name);
  end if;

  if v_unit_name = v_base_unit then
    v_factor := 1;
  else
    select puc.factor_to_base
      into v_factor
      from public.product_unit_conversions puc
      where puc.product_id = new.product_id
        and lower(puc.unit_name) = v_unit_name
        and puc.is_active = true
      limit 1;

    if coalesce(v_factor, 0) <= 0 then
      v_factor := nullif(new.factor_to_base, 0);
    end if;
    if coalesce(v_factor, 0) <= 0 then
      raise exception 'Unidad "%" no configurada para este producto', v_unit_name;
    end if;
  end if;

  v_qty_uom := greatest(coalesce(new.qty_uom, 0), 0);
  if v_qty_uom = 0 then
    if coalesce(new.qty, 0) > 0 and v_factor > 0 then
      v_qty_uom := new.qty / v_factor;
    else
      raise exception 'Cantidad invalida';
    end if;
  end if;

  v_cost_uom := coalesce(new.cost_unit_uom, 0);
  if v_cost_uom < 0 then
    raise exception 'Costo invalido';
  end if;
  if v_cost_uom = 0 and coalesce(new.cost_unit, 0) > 0 then
    v_cost_uom := new.cost_unit * v_factor;
  end if;

  new.unit_name := v_unit_name;
  new.factor_to_base := round(v_factor::numeric, 6);
  new.qty_uom := round(v_qty_uom::numeric, 3);
  new.cost_unit_uom := round(v_cost_uom::numeric, 4);

  new.qty := round((v_qty_uom * v_factor)::numeric, 3);
  if new.qty <= 0 then
    raise exception 'Cantidad base invalida';
  end if;
  new.cost_unit := round((v_cost_uom / v_factor)::numeric, 4);
  new.total_cost := round((v_qty_uom * v_cost_uom)::numeric, 2);

  return new;
end;
$$;


ALTER FUNCTION "public"."purchase_items_sync_base_fields"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."refresh_product_search_index"("p_product_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'extensions', 'public', 'pg_temp'
    AS $_$
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
$_$;


ALTER FUNCTION "public"."refresh_product_search_index"("p_product_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."replace_product_unit_conversions"("p_product_id" "uuid", "p_items" "jsonb") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_base_unit text;
  v_item jsonb;
  v_unit_name text;
  v_factor numeric;
  v_inserted integer := 0;
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  select coalesce(nullif(trim(unit), ''), 'unidad')
    into v_base_unit
    from public.products
    where id = p_product_id;

  if v_base_unit is null then
    raise exception 'Producto no encontrado';
  end if;

  v_base_unit := public.require_uom_code(v_base_unit);

  delete from public.product_unit_conversions
  where product_id = p_product_id;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    return 0;
  end if;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    if coalesce(trim(v_item->>'unit_name'), '') = '' then
      continue;
    end if;
    v_unit_name := public.require_uom_code(v_item->>'unit_name');

    if v_unit_name = v_base_unit then
      continue;
    end if;

    v_factor := nullif(v_item->>'factor_to_base', '')::numeric;
    if v_factor is null or v_factor <= 0 then
      raise exception 'Factor inválido para unidad "%"', v_unit_name;
    end if;

    insert into public.product_unit_conversions (
      product_id,
      unit_name,
      factor_to_base,
      is_active,
      created_at,
      updated_at
    ) values (
      p_product_id,
      v_unit_name,
      v_factor,
      coalesce((v_item->>'is_active')::boolean, true),
      now(),
      now()
    );

    v_inserted := v_inserted + 1;
  end loop;

  return v_inserted;
end;
$$;


ALTER FUNCTION "public"."replace_product_unit_conversions"("p_product_id" "uuid", "p_items" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."require_uom_code"("p_value" "text") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_code text;
begin
  v_code := public.resolve_uom_code(p_value);
  if v_code is null then
    raise exception 'Unidad "%" no existe en catálogo', coalesce(p_value, '');
  end if;
  return v_code;
end;
$$;


ALTER FUNCTION "public"."require_uom_code"("p_value" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."resolve_payment_method_code"("p_value" "text") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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


ALTER FUNCTION "public"."resolve_payment_method_code"("p_value" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."resolve_product_uom_factor"("p_product_id" "uuid", "p_unit_name" "text") RETURNS numeric
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_base_unit text;
  v_requested_unit text;
  v_factor numeric;
begin
  select coalesce(nullif(trim(unit), ''), 'unidad')
    into v_base_unit
    from public.products
    where id = p_product_id;

  if v_base_unit is null then
    raise exception 'Producto no encontrado';
  end if;

  v_base_unit := public.require_uom_code(v_base_unit);

  if coalesce(trim(p_unit_name), '') = '' then
    v_requested_unit := v_base_unit;
  else
    v_requested_unit := public.require_uom_code(p_unit_name);
  end if;

  if v_requested_unit = v_base_unit then
    return 1;
  end if;

  select factor_to_base
    into v_factor
    from public.product_unit_conversions
    where product_id = p_product_id
      and lower(unit_name) = v_requested_unit
      and is_active = true
    limit 1;

  if v_factor is null then
    raise exception 'Unidad "%" no configurada para este producto', v_requested_unit;
  end if;

  return v_factor;
end;
$$;


ALTER FUNCTION "public"."resolve_product_uom_factor"("p_product_id" "uuid", "p_unit_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."resolve_sale_item_pricing"("p_product_id" "uuid", "p_unit_name" "text", "p_qty_uom" numeric, "p_customer_id" "uuid" DEFAULT NULL::"uuid", "p_sale_at" timestamp with time zone DEFAULT "now"()) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_base_unit text;
  v_unit_name text;
  v_factor numeric;
  v_qty_uom numeric;
  v_qty_base numeric;
  v_customer_group text;
  v_base_price numeric;
  v_price_base numeric;
  v_price_uom numeric;
  v_currency char(3);
  v_rule_id uuid;
  v_rule_type text := 'base';
  v_source text := 'base';
  v_candidate numeric;
  v_promo_type text;
  v_promo_value numeric;
begin
  select
    coalesce(nullif(trim(p.unit), ''), 'unidad'),
    coalesce(pc.sale_price, p.sale_price, 0),
    coalesce(pc.currency, 'PEN')
    into v_base_unit, v_base_price, v_currency
  from public.products p
  left join public.product_catalog pc on pc.id = p.id
  where p.id = p_product_id
  limit 1;

  if v_base_unit is null then
    raise exception 'Producto no encontrado';
  end if;

  v_base_unit := public.require_uom_code(v_base_unit);
  if coalesce(trim(p_unit_name), '') = '' then
    v_unit_name := v_base_unit;
  else
    v_unit_name := public.require_uom_code(p_unit_name);
  end if;

  v_factor := public.resolve_product_uom_factor(p_product_id, v_unit_name);
  v_qty_uom := greatest(coalesce(p_qty_uom, 0), 0);
  if v_qty_uom = 0 then
    v_qty_uom := 1;
  end if;
  v_qty_base := v_qty_uom * v_factor;
  v_customer_group := public.customer_group_for_sale(p_customer_id);

  v_price_base := coalesce(v_base_price, 0);

  -- Precio por tipo de cliente
  v_rule_id := null;
  select r.id, r.unit_price_base
    into v_rule_id, v_candidate
    from public.product_customer_group_prices r
    where r.product_id = p_product_id
      and r.active = true
      and (r.customer_group is null or r.customer_group = v_customer_group)
      and (r.starts_at is null or r.starts_at <= p_sale_at)
      and (r.ends_at is null or r.ends_at >= p_sale_at)
    order by
      case when r.customer_group = v_customer_group then 0 else 1 end,
      r.priority asc,
      r.starts_at desc nulls last,
      r.created_at desc
    limit 1;

  if v_rule_id is not null then
    v_price_base := v_candidate;
    v_rule_type := 'customer_group';
    v_source := 'customer_group';
  end if;

  v_price_uom := v_price_base * v_factor;

  -- Precio por presentación
  v_rule_id := null;
  select r.id, r.price_uom
    into v_rule_id, v_candidate
    from public.product_presentation_prices r
    where r.product_id = p_product_id
      and r.unit_name = v_unit_name
      and r.active = true
      and (r.customer_group is null or r.customer_group = v_customer_group)
      and (r.starts_at is null or r.starts_at <= p_sale_at)
      and (r.ends_at is null or r.ends_at >= p_sale_at)
    order by
      case when r.customer_group = v_customer_group then 0 else 1 end,
      r.priority asc,
      r.starts_at desc nulls last,
      r.created_at desc
    limit 1;

  if v_rule_id is not null then
    v_price_uom := v_candidate;
    v_price_base := case when v_factor = 0 then 0 else v_price_uom / v_factor end;
    v_rule_type := 'presentation';
    v_source := 'presentation';
  end if;

  -- Precio mayorista por cantidad
  v_rule_id := null;
  select r.id, r.unit_price_base
    into v_rule_id, v_candidate
    from public.product_wholesale_tiers r
    where r.product_id = p_product_id
      and r.active = true
      and r.min_qty_base <= v_qty_base
      and (r.customer_group is null or r.customer_group = v_customer_group)
      and (r.starts_at is null or r.starts_at <= p_sale_at)
      and (r.ends_at is null or r.ends_at >= p_sale_at)
    order by
      r.min_qty_base desc,
      case when r.customer_group = v_customer_group then 0 else 1 end,
      r.priority asc,
      r.created_at desc
    limit 1;

  if v_rule_id is not null then
    v_price_base := v_candidate;
    v_price_uom := v_price_base * v_factor;
    v_rule_type := 'wholesale';
    v_source := 'wholesale';
  end if;

  -- Promoción temporal
  v_rule_id := null;
  select p.id, p.promo_type, p.promo_value
    into v_rule_id, v_promo_type, v_promo_value
    from public.product_promotions p
    where p.product_id = p_product_id
      and p.active = true
      and p.min_qty_base <= v_qty_base
      and p.starts_at <= p_sale_at
      and (p.ends_at is null or p.ends_at >= p_sale_at)
      and (p.customer_group is null or p.customer_group = v_customer_group)
      and (p.unit_name is null or p.unit_name = v_unit_name)
    order by
      case when p.customer_group = v_customer_group then 0 else 1 end,
      case when p.unit_name = v_unit_name then 0 else 1 end,
      p.priority asc,
      p.starts_at desc,
      p.created_at desc
    limit 1;

  if v_rule_id is not null then
    if v_promo_type = 'percent' then
      v_price_uom := v_price_uom * (1 - (v_promo_value / 100));
      v_source := v_source || '+promo_percent';
      v_rule_type := 'promotion_percent';
    elsif v_promo_type = 'fixed_price_uom' then
      v_price_uom := v_promo_value;
      v_source := v_source || '+promo_fixed';
      v_rule_type := 'promotion_fixed';
    end if;
    v_price_base := case when v_factor = 0 then 0 else v_price_uom / v_factor end;
  end if;

  v_price_uom := greatest(round(v_price_uom::numeric, 4), 0);
  v_price_base := greatest(round(v_price_base::numeric, 4), 0);

  return jsonb_build_object(
    'price_uom', v_price_uom,
    'price_base', v_price_base,
    'factor', v_factor,
    'qty_base', v_qty_base,
    'unit_name', v_unit_name,
    'base_unit', v_base_unit,
    'customer_group', v_customer_group,
    'currency', v_currency,
    'source', v_source,
    'rule_type', v_rule_type
  );
end;
$$;


ALTER FUNCTION "public"."resolve_sale_item_pricing"("p_product_id" "uuid", "p_unit_name" "text", "p_qty_uom" numeric, "p_customer_id" "uuid", "p_sale_at" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."resolve_uom_code"("p_value" "text") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_input text;
  v_code text;
begin
  v_input := public.normalize_uom_code(p_value);
  if v_input = '' then
    return null;
  end if;

  select u.code
    into v_code
    from public.uom_catalog u
    where u.active = true
      and (
        u.code = v_input
        or public.normalize_uom_code(u.label) = v_input
        or public.normalize_uom_code(u.label || 's') = v_input
        or public.normalize_uom_code(u.code || 's') = v_input
      )
    limit 1;

  return v_code;
end;
$$;


ALTER FUNCTION "public"."resolve_uom_code"("p_value" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sales_payment_method_guard"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  new.payment_method := coalesce(public.resolve_payment_method_code(new.payment_method), 'efectivo');
  return new;
end;
$$;


ALTER FUNCTION "public"."sales_payment_method_guard"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."search_normalize"("p_value" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE PARALLEL SAFE
    SET "search_path" TO 'extensions', 'public', 'pg_temp'
    AS $$
  select trim(regexp_replace(
    regexp_replace(
      lower(unaccent('unaccent'::regdictionary, replace(coalesce(p_value, ''), '#', ' cuadriculado '))),
      '[^a-z0-9.x ]+', ' ', 'g'),
    '\s+', ' ', 'g'))
$$;


ALTER FUNCTION "public"."search_normalize"("p_value" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."search_products_hybrid"("p_query" "text", "p_query_embedding" "public"."vector" DEFAULT NULL::"public"."vector", "p_match_count" integer DEFAULT 40) RETURNS TABLE("product_id" "uuid", "name" "text", "sku" "text", "brand" "text", "category" "text", "synonyms" "text"[], "lexical_rank" integer, "vector_rank" integer, "vector_similarity" double precision, "rrf_score" double precision)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'extensions', 'public', 'pg_temp'
    AS $$
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


ALTER FUNCTION "public"."search_products_hybrid"("p_query" "text", "p_query_embedding" "public"."vector", "p_match_count" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trg_categories_search_index"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  perform public.refresh_product_search_index(p.id) from public.products p where p.category_id = new.id;
  return null;
end;
$$;


ALTER FUNCTION "public"."trg_categories_search_index"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trg_products_search_index"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  perform public.refresh_product_search_index(new.id);
  return new;
end;
$$;


ALTER FUNCTION "public"."trg_products_search_index"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trg_synonyms_search_index"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  if tg_op in ('UPDATE', 'DELETE') then perform public.refresh_product_search_index(old.product_id); end if;
  if tg_op in ('INSERT', 'UPDATE') then perform public.refresh_product_search_index(new.product_id); end if;
  return null;
end;
$$;


ALTER FUNCTION "public"."trg_synonyms_search_index"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_whatsapp_last_interaction"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    NEW.last_interaction = NOW();
    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_whatsapp_last_interaction"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."upsert_product_catalog"("p_id" "uuid", "p_sku" "text", "p_name" "text", "p_unit" "text", "p_brand" "text", "p_product_type" "text", "p_barcode" "text", "p_active" boolean, "p_sale_price" numeric, "p_min_stock" numeric, "p_stock_on_hand" numeric DEFAULT NULL::numeric, "p_avg_cost" numeric DEFAULT NULL::numeric, "p_currency" "text" DEFAULT 'PEN'::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_product_id uuid;
  v_price_id uuid;
  v_current_price numeric;
  v_currency char(3);
  v_base_unit text;
  v_category_id uuid;
  v_category_name text;
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  if coalesce(trim(p_name), '') = '' then
    raise exception 'Nombre de producto obligatorio';
  end if;

  v_currency := upper(coalesce(nullif(trim(p_currency), ''), 'PEN'))::char(3);
  v_base_unit := public.require_uom_code(coalesce(nullif(trim(p_unit), ''), 'unidad'));
  v_category_name := nullif(trim(p_product_type), '');
  if v_category_name is not null then
    v_category_id := public.ensure_product_category(v_category_name);
    if v_category_id is not null then
      select c.name
        into v_category_name
        from public.product_categories c
        where c.id = v_category_id
        limit 1;
    end if;
  end if;

  if p_id is null and nullif(trim(p_sku), '') is not null then
    select id
      into v_product_id
      from public.products
      where sku = nullif(trim(p_sku), '')
      limit 1;
  end if;

  if p_id is null and v_product_id is null then
    insert into public.products (
      sku,
      name,
      unit,
      brand,
      category_id,
      product_type,
      barcode,
      active,
      sale_price,
      min_stock,
      updated_at
    ) values (
      nullif(trim(p_sku), ''),
      p_name,
      v_base_unit,
      nullif(trim(p_brand), ''),
      v_category_id,
      coalesce(v_category_name, nullif(trim(p_product_type), '')),
      nullif(trim(p_barcode), ''),
      coalesce(p_active, true),
      coalesce(p_sale_price, 0),
      coalesce(p_min_stock, 0),
      now()
    )
    returning id into v_product_id;
  else
    update public.products
      set sku = nullif(trim(p_sku), ''),
          name = p_name,
          unit = v_base_unit,
          brand = nullif(trim(p_brand), ''),
          category_id = coalesce(v_category_id, category_id),
          product_type = coalesce(v_category_name, product_type),
          barcode = nullif(trim(p_barcode), ''),
          active = coalesce(p_active, true),
          sale_price = coalesce(p_sale_price, 0),
          min_stock = coalesce(p_min_stock, 0),
          updated_at = now()
      where id = coalesce(p_id, v_product_id)
      returning id into v_product_id;

    if v_product_id is null then
      raise exception 'Producto no encontrado';
    end if;
  end if;

  insert into public.inventory_balances (product_id, stock_on_hand, avg_cost, min_stock, updated_at)
  values (
    v_product_id,
    coalesce(p_stock_on_hand, 0),
    coalesce(p_avg_cost, 0),
    coalesce(p_min_stock, 0),
    now()
  )
  on conflict (product_id) do nothing;

  update public.inventory_balances
    set stock_on_hand = coalesce(p_stock_on_hand, stock_on_hand),
        avg_cost = coalesce(p_avg_cost, avg_cost),
        min_stock = coalesce(p_min_stock, min_stock),
        updated_at = now()
    where product_id = v_product_id;

  select pp.id, pp.sale_price
    into v_price_id, v_current_price
    from public.product_prices pp
    where pp.product_id = v_product_id
      and pp.price_list = 'retail'
      and pp.currency = v_currency
      and pp.is_current = true
    order by pp.valid_from desc, pp.created_at desc
    limit 1;

  if v_price_id is null then
    insert into public.product_prices (
      product_id,
      price_list,
      regular_price,
      sale_price,
      currency,
      valid_from,
      is_current,
      created_by
    ) values (
      v_product_id,
      'retail',
      coalesce(p_sale_price, 0),
      coalesce(p_sale_price, 0),
      v_currency,
      now(),
      true,
      auth.uid()
    );
  elsif coalesce(v_current_price, 0) <> coalesce(p_sale_price, 0) then
    update public.product_prices
      set is_current = false,
          valid_to = now()
      where id = v_price_id;

    insert into public.product_prices (
      product_id,
      price_list,
      regular_price,
      sale_price,
      currency,
      valid_from,
      is_current,
      created_by
    ) values (
      v_product_id,
      'retail',
      coalesce(p_sale_price, 0),
      coalesce(p_sale_price, 0),
      v_currency,
      now(),
      true,
      auth.uid()
    );
  end if;

  update public.products
    set sale_price = coalesce(p_sale_price, 0),
        stock_on_hand = coalesce(p_stock_on_hand, stock_on_hand),
        avg_cost = coalesce(p_avg_cost, avg_cost),
        min_stock = coalesce(p_min_stock, 0),
        updated_at = now()
    where id = v_product_id;

  return v_product_id;
end;
$$;


ALTER FUNCTION "public"."upsert_product_catalog"("p_id" "uuid", "p_sku" "text", "p_name" "text", "p_unit" "text", "p_brand" "text", "p_product_type" "text", "p_barcode" "text", "p_active" boolean, "p_sale_price" numeric, "p_min_stock" numeric, "p_stock_on_hand" numeric, "p_avg_cost" numeric, "p_currency" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."user_role"() RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select role from public.profiles where id = auth.uid();
$$;


ALTER FUNCTION "public"."user_role"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."combo_workspaces" (
    "user_id" "uuid" NOT NULL,
    "combos" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "combo_workspaces_combos_check" CHECK (("jsonb_typeof"("combos") = 'array'::"text"))
);


ALTER TABLE "public"."combo_workspaces" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."customer_groups" (
    "code" "text" NOT NULL,
    "label" "text" NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "sort_order" integer DEFAULT 100 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."customer_groups" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."customers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "phone" "text",
    "email" "text",
    "address" "text",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "customer_group" "text" DEFAULT 'minorista'::"text"
);


ALTER TABLE "public"."customers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."image_cache" (
    "hash" "text" NOT NULL,
    "response_json" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL
);


ALTER TABLE "public"."image_cache" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."import_batches" (
    "batch_code" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."import_batches" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."institutions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "short_name" "text",
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."institutions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."inventory_balances" (
    "product_id" "uuid" NOT NULL,
    "stock_on_hand" numeric(12,3) DEFAULT 0 NOT NULL,
    "avg_cost" numeric(12,4) DEFAULT 0 NOT NULL,
    "min_stock" numeric(12,3) DEFAULT 0 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."inventory_balances" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."inventory_count_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "session_id" "uuid" NOT NULL,
    "product_id" "uuid" NOT NULL,
    "stock_system" numeric(12,3) DEFAULT 0 NOT NULL,
    "counted" numeric(12,3) DEFAULT 0 NOT NULL,
    "non_sellable" numeric(12,3) DEFAULT 0 NOT NULL,
    "stock_final" numeric(12,3) DEFAULT 0 NOT NULL,
    "delta_qty" numeric(12,3) DEFAULT 0 NOT NULL,
    "avg_cost" numeric(12,4) DEFAULT 0 NOT NULL,
    "reason" "text" NOT NULL,
    "reconfirmed" boolean DEFAULT false NOT NULL,
    "applied" boolean DEFAULT false NOT NULL,
    "applied_at" timestamp with time zone,
    "applied_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."inventory_count_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."inventory_count_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "code" "text" NOT NULL,
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "notes" "text",
    "opened_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "closed_at" timestamp with time zone,
    "created_by" "uuid",
    "closed_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "inventory_count_sessions_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'closed'::"text"])))
);


ALTER TABLE "public"."inventory_count_sessions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."match_cache" (
    "hash" "text" NOT NULL,
    "response_json" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL
);


ALTER TABLE "public"."match_cache" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payment_method_catalog" (
    "code" "text" NOT NULL,
    "label" "text" NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "sort_order" integer DEFAULT 100 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."payment_method_catalog" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."product_categories" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "code" "text" NOT NULL,
    "name" "text" NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "sort_order" integer DEFAULT 100 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."product_categories" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."product_prices" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "product_id" "uuid" NOT NULL,
    "price_list" "text" DEFAULT 'retail'::"text" NOT NULL,
    "regular_price" numeric(12,2) DEFAULT 0 NOT NULL,
    "sale_price" numeric(12,2) DEFAULT 0 NOT NULL,
    "currency" character(3) DEFAULT 'PEN'::"bpchar" NOT NULL,
    "valid_from" timestamp with time zone DEFAULT "now"() NOT NULL,
    "valid_to" timestamp with time zone,
    "is_current" boolean DEFAULT true NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."product_prices" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."product_unit_conversions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "product_id" "uuid" NOT NULL,
    "unit_name" "text" NOT NULL,
    "factor_to_base" numeric(12,6) NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "product_unit_conversions_factor_to_base_check" CHECK (("factor_to_base" > (0)::numeric))
);


ALTER TABLE "public"."product_unit_conversions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."products" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sku" "text",
    "name" "text" NOT NULL,
    "unit" "text" DEFAULT 'unidad'::"text" NOT NULL,
    "sale_price" numeric(12,2) DEFAULT 0 NOT NULL,
    "stock_on_hand" numeric(12,3) DEFAULT 0 NOT NULL,
    "avg_cost" numeric(12,4) DEFAULT 0 NOT NULL,
    "min_stock" numeric(12,3) DEFAULT 0 NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "description" "text",
    "brand" "text",
    "product_type" "text",
    "barcode" "text",
    "tax_code" "text",
    "taxable" boolean DEFAULT true NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "embedding" "public"."vector"(1536),
    "category_id" "uuid"
);


ALTER TABLE "public"."products" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."purchase_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "purchase_id" "uuid" NOT NULL,
    "product_id" "uuid" NOT NULL,
    "qty" numeric(12,3) NOT NULL,
    "cost_unit" numeric(12,4) NOT NULL,
    "total_cost" numeric(12,2) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "unit_name" "text" DEFAULT 'unidad'::"text" NOT NULL,
    "qty_uom" numeric(12,3) DEFAULT 0 NOT NULL,
    "factor_to_base" numeric(12,6) DEFAULT 1 NOT NULL,
    "cost_unit_uom" numeric(12,4) DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."purchase_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."purchases" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "supplier_id" "uuid",
    "invoice_no" "text",
    "purchase_date" timestamp with time zone DEFAULT "now"() NOT NULL,
    "total_cost" numeric(12,2) DEFAULT 0 NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."purchases" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sale_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sale_id" "uuid" NOT NULL,
    "product_id" "uuid" NOT NULL,
    "qty" numeric(12,3) NOT NULL,
    "price_unit" numeric(12,4) NOT NULL,
    "total" numeric(12,2) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "unit_name" "text" DEFAULT 'unidad'::"text" NOT NULL,
    "qty_uom" numeric(12,3) DEFAULT 0 NOT NULL,
    "factor_to_base" numeric(12,6) DEFAULT 1 NOT NULL,
    "price_unit_uom" numeric(12,4) DEFAULT 0 NOT NULL,
    "auto_price_unit" numeric(12,4) DEFAULT 0 NOT NULL,
    "pricing_source" "text",
    "pricing_detail" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "manual_discount_pct" numeric(6,2) DEFAULT 0 NOT NULL,
    "manual_discount_amount" numeric(12,4) DEFAULT 0 NOT NULL,
    "manual_discount_reason" "text"
);


ALTER TABLE "public"."sale_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sales" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "customer_id" "uuid",
    "sale_date" timestamp with time zone DEFAULT "now"() NOT NULL,
    "total" numeric(12,2) DEFAULT 0 NOT NULL,
    "payment_method" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "sold_by" "uuid",
    "approved_by" "uuid"
);


ALTER TABLE "public"."sales" OWNER TO "postgres";


COMMENT ON COLUMN "public"."sales"."sold_by" IS 'Vendedor de la venta. null en ventas anteriores a 20261116: usar coalesce(sold_by, created_by).';



COMMENT ON COLUMN "public"."sales"."approved_by" IS 'Propietario o encargado que aprobó una venta por confirmar del agente de voz; null si no hubo revisión.';



CREATE OR REPLACE VIEW "public"."product_catalog" WITH ("security_invoker"='true') AS
 SELECT "p"."id",
    "p"."sku",
    "p"."name",
    "p"."description",
    "p"."brand",
    COALESCE("pcat"."name", "p"."product_type") AS "product_type",
    "p"."unit",
    "p"."barcode",
    "p"."tax_code",
    "p"."taxable",
    "p"."active",
    COALESCE("cp"."sale_price", "p"."sale_price", (0)::numeric) AS "sale_price",
    COALESCE("inv"."stock_on_hand", "p"."stock_on_hand", (0)::numeric) AS "stock_on_hand",
    COALESCE("pcost"."avg_purchase_cost", "inv"."avg_cost", "p"."avg_cost", (0)::numeric) AS "avg_cost",
    COALESCE("inv"."min_stock", "p"."min_stock", (0)::numeric) AS "min_stock",
    "cp"."currency",
    "p"."created_at",
    "p"."updated_at",
    COALESCE("pcost"."last_purchase_cost", (0)::numeric) AS "last_purchase_cost",
    COALESCE("fifo"."fifo_stock_qty", (0)::numeric) AS "fifo_stock_qty",
    COALESCE("fifo"."fifo_stock_value", (0)::numeric) AS "fifo_stock_value",
    COALESCE("fifo"."fifo_next_cost", (0)::numeric) AS "fifo_next_cost",
    COALESCE("uom"."needs_presentation_setup", false) AS "needs_presentation_setup",
    COALESCE("uom"."missing_purchase_units", ARRAY[]::"text"[]) AS "missing_purchase_units",
    COALESCE("fifo"."fifo_next_qty", (0)::numeric) AS "fifo_next_qty",
    "p"."category_id",
    "pcat"."code" AS "category_code",
    "pcat"."name" AS "category_name"
   FROM (((((("public"."products" "p"
     LEFT JOIN "public"."product_categories" "pcat" ON (("pcat"."id" = "p"."category_id")))
     LEFT JOIN LATERAL ( SELECT "pp"."sale_price",
            "pp"."currency"
           FROM "public"."product_prices" "pp"
          WHERE (("pp"."product_id" = "p"."id") AND ("pp"."price_list" = 'retail'::"text") AND ("pp"."is_current" = true))
          ORDER BY "pp"."valid_from" DESC, "pp"."created_at" DESC
         LIMIT 1) "cp" ON (true))
     LEFT JOIN LATERAL ( WITH "base_unit" AS (
                 SELECT COALESCE("public"."resolve_uom_code"("p"."unit"), "public"."normalize_uom_code"("p"."unit"), 'unidad'::"text") AS "base_unit_code"
                ), "purchase_units" AS (
                 SELECT DISTINCT COALESCE("public"."resolve_uom_code"("pi"."unit_name"), "public"."normalize_uom_code"("pi"."unit_name"), 'unidad'::"text") AS "unit_code"
                   FROM "public"."purchase_items" "pi"
                  WHERE ("pi"."product_id" = "p"."id")
                ), "missing" AS (
                 SELECT "pu"."unit_code"
                   FROM ("purchase_units" "pu"
                     CROSS JOIN "base_unit" "bu")
                  WHERE (("pu"."unit_code" <> "bu"."base_unit_code") AND (NOT (EXISTS ( SELECT 1
                           FROM "public"."product_unit_conversions" "puc"
                          WHERE (("puc"."product_id" = "p"."id") AND (COALESCE("public"."resolve_uom_code"("puc"."unit_name"), "public"."normalize_uom_code"("puc"."unit_name"), 'unidad'::"text") = "pu"."unit_code") AND ("puc"."is_active" = true))))))
                )
         SELECT ( SELECT ("count"(*) > 0)
                   FROM "missing") AS "needs_presentation_setup",
            COALESCE(( SELECT "array_agg"("m"."unit_code" ORDER BY "m"."unit_code") AS "array_agg"
                   FROM "missing" "m"), ARRAY[]::"text"[]) AS "missing_purchase_units") "uom" ON (true))
     LEFT JOIN LATERAL ( WITH "pi_norm" AS (
                 SELECT "pi"."id",
                    COALESCE("pi"."total_cost", (0)::numeric) AS "total_cost",
                    COALESCE("pi"."cost_unit", (0)::numeric) AS "cost_unit_base",
                    COALESCE("pi"."qty", (0)::numeric) AS "qty_base_recorded",
                    COALESCE("pi"."qty_uom", (0)::numeric) AS "qty_uom_recorded",
                    COALESCE("pi"."factor_to_base", (0)::numeric) AS "factor_item",
                    COALESCE("puc"."factor_to_base", (0)::numeric) AS "factor_catalog",
                    COALESCE("public"."resolve_uom_code"("pi"."unit_name"), "public"."normalize_uom_code"("pi"."unit_name"), 'unidad'::"text") AS "unit_code",
                    COALESCE("public"."resolve_uom_code"("p"."unit"), "public"."normalize_uom_code"("p"."unit"), 'unidad'::"text") AS "base_unit_code",
                    COALESCE("pu"."purchase_date", "pu"."created_at", "pi"."created_at", "now"()) AS "purchase_dt",
                    COALESCE("pi"."created_at", "pu"."created_at", "now"()) AS "item_dt"
                   FROM (("public"."purchase_items" "pi"
                     JOIN "public"."purchases" "pu" ON (("pu"."id" = "pi"."purchase_id")))
                     LEFT JOIN "public"."product_unit_conversions" "puc" ON ((("puc"."product_id" = "pi"."product_id") AND (COALESCE("public"."resolve_uom_code"("puc"."unit_name"), "public"."normalize_uom_code"("puc"."unit_name"), 'unidad'::"text") = COALESCE("public"."resolve_uom_code"("pi"."unit_name"), "public"."normalize_uom_code"("pi"."unit_name"), 'unidad'::"text")) AND ("puc"."is_active" = true))))
                  WHERE ("pi"."product_id" = "p"."id")
                ), "pi_calc" AS (
                 SELECT "pi_norm"."id",
                    "pi_norm"."total_cost",
                    "pi_norm"."cost_unit_base",
                    "pi_norm"."purchase_dt",
                    "pi_norm"."item_dt",
                    "pi_norm"."qty_uom_recorded",
                        CASE
                            WHEN ("pi_norm"."unit_code" = "pi_norm"."base_unit_code") THEN (1)::numeric
                            WHEN ("pi_norm"."factor_catalog" > (0)::numeric) THEN "pi_norm"."factor_catalog"
                            ELSE NULL::numeric
                        END AS "factor_effective"
                   FROM "pi_norm"
                ), "pi_metrics" AS (
                 SELECT "pi_calc"."id",
                    "pi_calc"."total_cost",
                    "pi_calc"."purchase_dt",
                    "pi_calc"."item_dt",
                        CASE
                            WHEN (("pi_calc"."qty_uom_recorded" > (0)::numeric) AND ("pi_calc"."factor_effective" > (0)::numeric)) THEN ("pi_calc"."qty_uom_recorded" * "pi_calc"."factor_effective")
                            ELSE (0)::numeric
                        END AS "qty_base_effective",
                        CASE
                            WHEN (
                            CASE
                                WHEN (("pi_calc"."qty_uom_recorded" > (0)::numeric) AND ("pi_calc"."factor_effective" > (0)::numeric)) THEN ("pi_calc"."qty_uom_recorded" * "pi_calc"."factor_effective")
                                ELSE (0)::numeric
                            END > (0)::numeric) THEN "round"(("pi_calc"."total_cost" /
                            CASE
                                WHEN (("pi_calc"."qty_uom_recorded" > (0)::numeric) AND ("pi_calc"."factor_effective" > (0)::numeric)) THEN ("pi_calc"."qty_uom_recorded" * "pi_calc"."factor_effective")
                                ELSE (1)::numeric
                            END), 4)
                            ELSE "pi_calc"."cost_unit_base"
                        END AS "cost_unit_effective"
                   FROM "pi_calc"
                )
         SELECT
                CASE
                    WHEN ("sum"("pi_metrics"."qty_base_effective") > (0)::numeric) THEN "round"(("sum"("pi_metrics"."total_cost") / "sum"("pi_metrics"."qty_base_effective")), 4)
                    ELSE NULL::numeric
                END AS "avg_purchase_cost",
            ( SELECT "m"."cost_unit_effective"
                   FROM "pi_metrics" "m"
                  ORDER BY "m"."purchase_dt" DESC, "m"."item_dt" DESC, "m"."id" DESC
                 LIMIT 1) AS "last_purchase_cost"
           FROM "pi_metrics") "pcost" ON (true))
     LEFT JOIN LATERAL ( WITH "base_unit" AS (
                 SELECT COALESCE("public"."resolve_uom_code"("p"."unit"), "public"."normalize_uom_code"("p"."unit"), 'unidad'::"text") AS "base_unit_code"
                ), "purchase_raw" AS (
                 SELECT "pi"."id",
                    COALESCE("pu"."purchase_date", "pu"."created_at", "pi"."created_at", "now"()) AS "purchase_dt",
                    COALESCE("pi"."created_at", "pu"."created_at", "now"()) AS "item_dt",
                    COALESCE("pi"."total_cost", (0)::numeric) AS "total_cost",
                    COALESCE("pi"."qty_uom", (0)::numeric) AS "qty_uom_raw",
                    COALESCE("public"."resolve_uom_code"("pi"."unit_name"), "public"."normalize_uom_code"("pi"."unit_name"), 'unidad'::"text") AS "unit_code",
                    COALESCE("puc"."factor_to_base", (0)::numeric) AS "factor_catalog",
                    "bu"."base_unit_code"
                   FROM ((("public"."purchase_items" "pi"
                     JOIN "public"."purchases" "pu" ON (("pu"."id" = "pi"."purchase_id")))
                     CROSS JOIN "base_unit" "bu")
                     LEFT JOIN "public"."product_unit_conversions" "puc" ON ((("puc"."product_id" = "pi"."product_id") AND (COALESCE("public"."resolve_uom_code"("puc"."unit_name"), "public"."normalize_uom_code"("puc"."unit_name"), 'unidad'::"text") = COALESCE("public"."resolve_uom_code"("pi"."unit_name"), "public"."normalize_uom_code"("pi"."unit_name"), 'unidad'::"text")) AND ("puc"."is_active" = true))))
                  WHERE ("pi"."product_id" = "p"."id")
                ), "purchase_metrics" AS (
                 SELECT "pr"."id",
                    "pr"."purchase_dt",
                    "pr"."item_dt",
                        CASE
                            WHEN ("pr"."unit_code" = "pr"."base_unit_code") THEN (1)::numeric
                            WHEN ("pr"."factor_catalog" > (0)::numeric) THEN "pr"."factor_catalog"
                            ELSE NULL::numeric
                        END AS "factor_effective",
                    "pr"."qty_uom_raw",
                    "pr"."total_cost"
                   FROM "purchase_raw" "pr"
                ), "purchase_layers" AS (
                 SELECT "pm"."id",
                    "pm"."purchase_dt",
                    "pm"."item_dt",
                    ("pm"."qty_uom_raw" * "pm"."factor_effective") AS "qty_base_effective",
                        CASE
                            WHEN (("pm"."qty_uom_raw" * "pm"."factor_effective") > (0)::numeric) THEN "round"(("pm"."total_cost" / ("pm"."qty_uom_raw" * "pm"."factor_effective")), 4)
                            ELSE (0)::numeric
                        END AS "cost_base_effective"
                   FROM "purchase_metrics" "pm"
                  WHERE (("pm"."factor_effective" > (0)::numeric) AND ("pm"."qty_uom_raw" > (0)::numeric))
                ), "sales_raw" AS (
                 SELECT "si"."id",
                    COALESCE("s"."sale_date", "s"."created_at", "si"."created_at", "now"()) AS "sale_dt",
                    COALESCE("si"."qty_uom", (0)::numeric) AS "qty_uom_raw",
                    COALESCE("public"."resolve_uom_code"("si"."unit_name"), "public"."normalize_uom_code"("si"."unit_name"), 'unidad'::"text") AS "unit_code",
                    COALESCE("puc"."factor_to_base", (0)::numeric) AS "factor_catalog",
                    "bu"."base_unit_code"
                   FROM ((("public"."sale_items" "si"
                     JOIN "public"."sales" "s" ON (("s"."id" = "si"."sale_id")))
                     CROSS JOIN "base_unit" "bu")
                     LEFT JOIN "public"."product_unit_conversions" "puc" ON ((("puc"."product_id" = "si"."product_id") AND (COALESCE("public"."resolve_uom_code"("puc"."unit_name"), "public"."normalize_uom_code"("puc"."unit_name"), 'unidad'::"text") = COALESCE("public"."resolve_uom_code"("si"."unit_name"), "public"."normalize_uom_code"("si"."unit_name"), 'unidad'::"text")) AND ("puc"."is_active" = true))))
                  WHERE ("si"."product_id" = "p"."id")
                ), "sales_metrics" AS (
                 SELECT "sr"."id",
                    "sr"."sale_dt",
                        CASE
                            WHEN ("sr"."unit_code" = "sr"."base_unit_code") THEN (1)::numeric
                            WHEN ("sr"."factor_catalog" > (0)::numeric) THEN "sr"."factor_catalog"
                            ELSE NULL::numeric
                        END AS "factor_effective",
                    "sr"."qty_uom_raw"
                   FROM "sales_raw" "sr"
                ), "sold_total" AS (
                 SELECT COALESCE("sum"(("sm"."qty_uom_raw" * "sm"."factor_effective")), (0)::numeric) AS "qty_sold_base"
                   FROM "sales_metrics" "sm"
                  WHERE (("sm"."factor_effective" > (0)::numeric) AND ("sm"."qty_uom_raw" > (0)::numeric))
                ), "purchase_ranked" AS (
                 SELECT "pl"."id",
                    "pl"."purchase_dt",
                    "pl"."item_dt",
                    "pl"."qty_base_effective",
                    "pl"."cost_base_effective",
                    "sum"("pl"."qty_base_effective") OVER (ORDER BY "pl"."purchase_dt", "pl"."item_dt", "pl"."id") AS "purchased_cum",
                    COALESCE("sum"("pl"."qty_base_effective") OVER (ORDER BY "pl"."purchase_dt", "pl"."item_dt", "pl"."id" ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), (0)::numeric) AS "purchased_cum_prev"
                   FROM "purchase_layers" "pl"
                ), "layer_remaining" AS (
                 SELECT "pr"."purchase_dt",
                    "pr"."item_dt",
                    "pr"."id",
                    "pr"."cost_base_effective",
                    GREATEST((0)::numeric, ("pr"."qty_base_effective" - GREATEST((0)::numeric, LEAST("pr"."qty_base_effective", ("st"."qty_sold_base" - "pr"."purchased_cum_prev"))))) AS "qty_remaining_effective"
                   FROM ("purchase_ranked" "pr"
                     CROSS JOIN "sold_total" "st")
                )
         SELECT (COALESCE("sum"("lr"."qty_remaining_effective"), (0)::numeric))::numeric(12,3) AS "fifo_stock_qty",
            (COALESCE("sum"(("lr"."qty_remaining_effective" * "lr"."cost_base_effective")), (0)::numeric))::numeric(14,4) AS "fifo_stock_value",
            (( SELECT "lr2"."cost_base_effective"
                   FROM "layer_remaining" "lr2"
                  WHERE ("lr2"."qty_remaining_effective" > (0)::numeric)
                  ORDER BY "lr2"."purchase_dt", "lr2"."item_dt", "lr2"."id"
                 LIMIT 1))::numeric(12,4) AS "fifo_next_cost",
            (( SELECT "lr2"."qty_remaining_effective"
                   FROM "layer_remaining" "lr2"
                  WHERE ("lr2"."qty_remaining_effective" > (0)::numeric)
                  ORDER BY "lr2"."purchase_dt", "lr2"."item_dt", "lr2"."id"
                 LIMIT 1))::numeric(12,3) AS "fifo_next_qty"
           FROM "layer_remaining" "lr") "fifo" ON (true))
     LEFT JOIN "public"."inventory_balances" "inv" ON (("inv"."product_id" = "p"."id")));


ALTER VIEW "public"."product_catalog" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."product_customer_group_prices" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "product_id" "uuid" NOT NULL,
    "customer_group" "text",
    "unit_price_base" numeric(12,4) NOT NULL,
    "currency" character(3) DEFAULT 'PEN'::"bpchar" NOT NULL,
    "starts_at" timestamp with time zone,
    "ends_at" timestamp with time zone,
    "priority" integer DEFAULT 100 NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "product_customer_group_prices_unit_price_base_check" CHECK (("unit_price_base" >= (0)::numeric))
);


ALTER TABLE "public"."product_customer_group_prices" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."product_presentation_prices" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "product_id" "uuid" NOT NULL,
    "unit_name" "text" NOT NULL,
    "customer_group" "text",
    "price_uom" numeric(12,4) NOT NULL,
    "currency" character(3) DEFAULT 'PEN'::"bpchar" NOT NULL,
    "starts_at" timestamp with time zone,
    "ends_at" timestamp with time zone,
    "priority" integer DEFAULT 100 NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "product_presentation_prices_price_uom_check" CHECK (("price_uom" >= (0)::numeric))
);


ALTER TABLE "public"."product_presentation_prices" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."product_promotions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "product_id" "uuid" NOT NULL,
    "unit_name" "text",
    "customer_group" "text",
    "promo_type" "text" NOT NULL,
    "promo_value" numeric(12,4) NOT NULL,
    "min_qty_base" numeric(12,3) DEFAULT 1 NOT NULL,
    "starts_at" timestamp with time zone NOT NULL,
    "ends_at" timestamp with time zone,
    "priority" integer DEFAULT 100 NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "product_promotions_min_qty_base_check" CHECK (("min_qty_base" > (0)::numeric)),
    CONSTRAINT "product_promotions_promo_type_check" CHECK (("promo_type" = ANY (ARRAY['percent'::"text", 'fixed_price_uom'::"text"]))),
    CONSTRAINT "product_promotions_promo_value_check" CHECK (("promo_value" > (0)::numeric))
);


ALTER TABLE "public"."product_promotions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."product_search_index" (
    "product_id" "uuid" NOT NULL,
    "document" "text" NOT NULL,
    "search_text" "text" NOT NULL,
    "content_hash" "text" NOT NULL,
    "embedding" "public"."vector"(1536),
    "embedding_model" "text",
    "embedded_hash" "text",
    "embedded_at" timestamp with time zone,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."product_search_index" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."product_search_synonyms" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "product_id" "uuid" NOT NULL,
    "phrase" "text" NOT NULL,
    "phrase_norm" "text" GENERATED ALWAYS AS ("public"."search_normalize"("phrase")) STORED,
    "source" "text" DEFAULT 'manual'::"text" NOT NULL,
    "hits" integer DEFAULT 0 NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "product_search_synonyms_phrase_check" CHECK ((("char_length"(TRIM(BOTH FROM "phrase")) >= 2) AND ("char_length"(TRIM(BOTH FROM "phrase")) <= 200))),
    CONSTRAINT "product_search_synonyms_source_check" CHECK (("source" = ANY (ARRAY['manual'::"text", 'sale_review'::"text", 'import'::"text"])))
);


ALTER TABLE "public"."product_search_synonyms" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."product_wholesale_tiers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "product_id" "uuid" NOT NULL,
    "customer_group" "text",
    "min_qty_base" numeric(12,3) NOT NULL,
    "unit_price_base" numeric(12,4) NOT NULL,
    "starts_at" timestamp with time zone,
    "ends_at" timestamp with time zone,
    "priority" integer DEFAULT 100 NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "product_wholesale_tiers_min_qty_base_check" CHECK (("min_qty_base" > (0)::numeric)),
    CONSTRAINT "product_wholesale_tiers_unit_price_base_check" CHECK (("unit_price_base" >= (0)::numeric))
);


ALTER TABLE "public"."product_wholesale_tiers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "full_name" "text",
    "role" "text" DEFAULT 'cashier'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "profiles_role_check" CHECK (("role" = ANY (ARRAY['owner'::"text", 'manager'::"text", 'cashier'::"text"])))
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sale_cost_allocations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sale_id" "uuid" NOT NULL,
    "sale_item_id" "uuid" NOT NULL,
    "product_id" "uuid" NOT NULL,
    "layer_id" "uuid" NOT NULL,
    "qty" numeric(12,3) NOT NULL,
    "cost_unit" numeric(12,4) NOT NULL,
    "total_cost" numeric(12,4) DEFAULT 0 NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "sale_cost_allocations_cost_unit_check" CHECK (("cost_unit" >= (0)::numeric)),
    CONSTRAINT "sale_cost_allocations_qty_check" CHECK (("qty" > (0)::numeric))
);


ALTER TABLE "public"."sale_cost_allocations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sales_order_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "order_id" "uuid" NOT NULL,
    "product_id" "uuid" NOT NULL,
    "unit_name" "text" NOT NULL,
    "qty_uom" numeric(12,3) NOT NULL,
    "factor_to_base" numeric(12,6) NOT NULL,
    "auto_price_unit" numeric(12,4) DEFAULT 0 NOT NULL,
    "price_unit_uom" numeric(12,4) NOT NULL,
    "pricing_source" "text",
    "pricing_detail" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "total" numeric(12,2) DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "sales_order_items_factor_to_base_check" CHECK (("factor_to_base" > (0)::numeric)),
    CONSTRAINT "sales_order_items_price_unit_uom_check" CHECK (("price_unit_uom" >= (0)::numeric)),
    CONSTRAINT "sales_order_items_qty_uom_check" CHECK (("qty_uom" > (0)::numeric))
);


ALTER TABLE "public"."sales_order_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sales_orders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "order_code" "text" NOT NULL,
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "customer_id" "uuid",
    "payment_method" "text",
    "notes" "text",
    "total" numeric(12,2) DEFAULT 0 NOT NULL,
    "paid_sale_id" "uuid",
    "paid_at" timestamp with time zone,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "sales_orders_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'paid'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."sales_orders" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."school_grades" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "institution_id" "uuid" NOT NULL,
    "level" "text" NOT NULL,
    "name" "text" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    CONSTRAINT "school_grades_level_check" CHECK (("level" = ANY (ARRAY['inicial'::"text", 'primaria'::"text", 'secundaria'::"text"])))
);


ALTER TABLE "public"."school_grades" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."school_list_item_brands" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "item_id" "uuid" NOT NULL,
    "product_id" "uuid" NOT NULL,
    "brand" "text" NOT NULL,
    "is_default" boolean DEFAULT false NOT NULL,
    "pricing_rule_id" "uuid",
    "pricing_unit_name" "text",
    "pricing_label" "text",
    "pricing_price_uom" numeric(12,4),
    "pricing_factor_to_base" numeric(12,6)
);


ALTER TABLE "public"."school_list_item_brands" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."school_list_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "list_id" "uuid" NOT NULL,
    "item_description" "text" NOT NULL,
    "qty" integer DEFAULT 1 NOT NULL,
    "notes" "text",
    "sort_order" integer DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."school_list_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."school_lists" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "institution_id" "uuid" NOT NULL,
    "grade_id" "uuid" NOT NULL,
    "section_id" "uuid" NOT NULL,
    "year" integer DEFAULT EXTRACT(year FROM "now"()) NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."school_lists" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."school_sections" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "grade_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "active" boolean DEFAULT true NOT NULL
);


ALTER TABLE "public"."school_sections" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."stg_compras_ayrampo_import" (
    "supplier_name" "text",
    "supplier_code" "text",
    "purchase_batch" "text",
    "product_sku" "text",
    "product_name" "text",
    "unit" "text",
    "qty" numeric,
    "cost_unit" numeric,
    "total_cost" numeric,
    "etiqueta_nuevo" "text"
);


ALTER TABLE "public"."stg_compras_ayrampo_import" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."stg_compras_tania_import" (
    "supplier_name" "text",
    "supplier_code" "text",
    "purchase_batch" "text",
    "product_sku" "text",
    "product_name" "text",
    "unit" "text",
    "qty" numeric,
    "cost_unit" numeric,
    "total_cost" numeric,
    "etiqueta_nuevo" "text"
);


ALTER TABLE "public"."stg_compras_tania_import" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."stg_productos_import" (
    "sku" "text",
    "producto" "text",
    "tipo" "text",
    "marca" "text",
    "unidad" "text",
    "precio_venta_referencia" numeric,
    "costo_referencia" numeric,
    "etiqueta_nuevo" "text"
);


ALTER TABLE "public"."stg_productos_import" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."stg_stock_actual_hoja2_import" (
    "product_sku" "text",
    "product_name" "text",
    "brand" "text",
    "tipo" "text",
    "unit" "text",
    "stock_current" numeric
);


ALTER TABLE "public"."stg_stock_actual_hoja2_import" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."stg_ventas_hoja2_import" (
    "sale_ref" "text",
    "customer_code" "text",
    "customer_name" "text",
    "product_sku" "text",
    "product_name" "text",
    "brand" "text",
    "tipo" "text",
    "unit" "text",
    "qty" numeric,
    "price_unit" numeric,
    "line_total" numeric,
    "cost_total" numeric,
    "profit_total" numeric,
    "weeks" "text"
);


ALTER TABLE "public"."stg_ventas_hoja2_import" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."stg_ventas_hoja2_zero_import" (
    "product_sku" "text",
    "product_name" "text",
    "brand" "text",
    "tipo" "text",
    "unit" "text",
    "customer_code" "text",
    "customer_name" "text",
    "week_ref" "text",
    "qty" numeric,
    "price_unit" numeric,
    "cost_unit" numeric,
    "sales_total" numeric,
    "cost_total" numeric,
    "profit_total" numeric
);


ALTER TABLE "public"."stg_ventas_hoja2_zero_import" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."stock_cost_layers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "fifo_order" bigint NOT NULL,
    "product_id" "uuid" NOT NULL,
    "purchase_id" "uuid",
    "purchase_item_id" "uuid",
    "source" "text" DEFAULT 'purchase'::"text" NOT NULL,
    "layer_date" timestamp with time zone DEFAULT "now"() NOT NULL,
    "qty_in" numeric(12,3) NOT NULL,
    "qty_remaining" numeric(12,3) NOT NULL,
    "cost_unit" numeric(12,4) NOT NULL,
    "note" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "stock_cost_layers_cost_unit_check" CHECK (("cost_unit" >= (0)::numeric)),
    CONSTRAINT "stock_cost_layers_qty_in_check" CHECK (("qty_in" >= (0)::numeric)),
    CONSTRAINT "stock_cost_layers_qty_remaining_check" CHECK (("qty_remaining" >= (0)::numeric))
);


ALTER TABLE "public"."stock_cost_layers" OWNER TO "postgres";


ALTER TABLE "public"."stock_cost_layers" ALTER COLUMN "fifo_order" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."stock_cost_layers_fifo_order_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."stock_movements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "product_id" "uuid" NOT NULL,
    "movement_type" "text" NOT NULL,
    "qty" numeric(12,3) NOT NULL,
    "cost_unit" numeric(12,4),
    "ref_table" "text",
    "ref_id" "uuid",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "stock_movements_movement_type_check" CHECK (("movement_type" = ANY (ARRAY['purchase'::"text", 'sale'::"text", 'adjust'::"text"])))
);


ALTER TABLE "public"."stock_movements" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."supplier_quote_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "quote_id" "uuid" NOT NULL,
    "product_id" "uuid" NOT NULL,
    "qty" numeric(12,3) NOT NULL,
    "suggested_qty" numeric(12,3) DEFAULT 0 NOT NULL,
    "unit_name" "text" DEFAULT 'unidad'::"text" NOT NULL,
    "cost_unit" numeric(12,4) DEFAULT 0 NOT NULL,
    "line_total" numeric(14,2) DEFAULT 0 NOT NULL,
    "product_snapshot_name" "text",
    "product_snapshot_sku" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "product_snapshot_brand" "text",
    CONSTRAINT "supplier_quote_items_cost_unit_check" CHECK (("cost_unit" >= (0)::numeric)),
    CONSTRAINT "supplier_quote_items_line_total_check" CHECK (("line_total" >= (0)::numeric)),
    CONSTRAINT "supplier_quote_items_qty_check" CHECK (("qty" > (0)::numeric))
);


ALTER TABLE "public"."supplier_quote_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."supplier_quotes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "supplier_id" "uuid" NOT NULL,
    "min_required_units" integer DEFAULT 12 NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "notes" "text",
    "total_items" integer DEFAULT 0 NOT NULL,
    "total_units" numeric(12,3) DEFAULT 0 NOT NULL,
    "total_cost" numeric(14,2) DEFAULT 0 NOT NULL,
    "created_by" "uuid" DEFAULT "auth"."uid"(),
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "supplier_quotes_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'sent'::"text", 'approved'::"text", 'rejected'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."supplier_quotes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."suppliers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "phone" "text",
    "email" "text",
    "address" "text",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."suppliers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."uom_catalog" (
    "code" "text" NOT NULL,
    "label" "text" NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."uom_catalog" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."whatsapp_sessions" (
    "phone_number" "text" NOT NULL,
    "state" "text" DEFAULT 'WAITING_LIST'::"text" NOT NULL,
    "draft_cart" "jsonb" DEFAULT '{}'::"jsonb",
    "last_interaction" timestamp with time zone DEFAULT "now"(),
    "created_at" timestamp with time zone DEFAULT "now"(),
    "current_order_id" "uuid",
    "preferences" "jsonb" DEFAULT '{}'::"jsonb",
    "school_selection" "jsonb" DEFAULT '{}'::"jsonb"
);


ALTER TABLE "public"."whatsapp_sessions" OWNER TO "postgres";


ALTER TABLE ONLY "public"."combo_workspaces"
    ADD CONSTRAINT "combo_workspaces_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."customer_groups"
    ADD CONSTRAINT "customer_groups_pkey" PRIMARY KEY ("code");



ALTER TABLE ONLY "public"."customers"
    ADD CONSTRAINT "customers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."image_cache"
    ADD CONSTRAINT "image_cache_pkey" PRIMARY KEY ("hash");



ALTER TABLE ONLY "public"."import_batches"
    ADD CONSTRAINT "import_batches_pkey" PRIMARY KEY ("batch_code");



ALTER TABLE ONLY "public"."institutions"
    ADD CONSTRAINT "institutions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."inventory_balances"
    ADD CONSTRAINT "inventory_balances_pkey" PRIMARY KEY ("product_id");



ALTER TABLE ONLY "public"."inventory_count_items"
    ADD CONSTRAINT "inventory_count_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."inventory_count_items"
    ADD CONSTRAINT "inventory_count_items_session_id_product_id_key" UNIQUE ("session_id", "product_id");



ALTER TABLE ONLY "public"."inventory_count_sessions"
    ADD CONSTRAINT "inventory_count_sessions_code_key" UNIQUE ("code");



ALTER TABLE ONLY "public"."inventory_count_sessions"
    ADD CONSTRAINT "inventory_count_sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."match_cache"
    ADD CONSTRAINT "match_cache_pkey" PRIMARY KEY ("hash");



ALTER TABLE ONLY "public"."payment_method_catalog"
    ADD CONSTRAINT "payment_method_catalog_pkey" PRIMARY KEY ("code");



ALTER TABLE ONLY "public"."product_categories"
    ADD CONSTRAINT "product_categories_code_key" UNIQUE ("code");



ALTER TABLE ONLY "public"."product_categories"
    ADD CONSTRAINT "product_categories_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."product_customer_group_prices"
    ADD CONSTRAINT "product_customer_group_prices_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."product_presentation_prices"
    ADD CONSTRAINT "product_presentation_prices_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."product_prices"
    ADD CONSTRAINT "product_prices_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."product_promotions"
    ADD CONSTRAINT "product_promotions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."product_search_index"
    ADD CONSTRAINT "product_search_index_pkey" PRIMARY KEY ("product_id");



ALTER TABLE ONLY "public"."product_search_synonyms"
    ADD CONSTRAINT "product_search_synonyms_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."product_search_synonyms"
    ADD CONSTRAINT "product_search_synonyms_product_id_phrase_norm_key" UNIQUE ("product_id", "phrase_norm");



ALTER TABLE ONLY "public"."product_unit_conversions"
    ADD CONSTRAINT "product_unit_conversions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."product_wholesale_tiers"
    ADD CONSTRAINT "product_wholesale_tiers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_sku_key" UNIQUE ("sku");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."purchase_items"
    ADD CONSTRAINT "purchase_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."purchases"
    ADD CONSTRAINT "purchases_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sale_cost_allocations"
    ADD CONSTRAINT "sale_cost_allocations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sale_items"
    ADD CONSTRAINT "sale_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sales_order_items"
    ADD CONSTRAINT "sales_order_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sales_orders"
    ADD CONSTRAINT "sales_orders_order_code_key" UNIQUE ("order_code");



ALTER TABLE ONLY "public"."sales_orders"
    ADD CONSTRAINT "sales_orders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sales"
    ADD CONSTRAINT "sales_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."school_grades"
    ADD CONSTRAINT "school_grades_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."school_list_item_brands"
    ADD CONSTRAINT "school_list_item_brands_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."school_list_items"
    ADD CONSTRAINT "school_list_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."school_lists"
    ADD CONSTRAINT "school_lists_institution_id_grade_id_section_id_year_key" UNIQUE ("institution_id", "grade_id", "section_id", "year");



ALTER TABLE ONLY "public"."school_lists"
    ADD CONSTRAINT "school_lists_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."school_sections"
    ADD CONSTRAINT "school_sections_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."stock_cost_layers"
    ADD CONSTRAINT "stock_cost_layers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."stock_cost_layers"
    ADD CONSTRAINT "stock_cost_layers_purchase_item_id_key" UNIQUE ("purchase_item_id");



ALTER TABLE ONLY "public"."stock_movements"
    ADD CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."supplier_quote_items"
    ADD CONSTRAINT "supplier_quote_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."supplier_quotes"
    ADD CONSTRAINT "supplier_quotes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."suppliers"
    ADD CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."uom_catalog"
    ADD CONSTRAINT "uom_catalog_pkey" PRIMARY KEY ("code");



ALTER TABLE ONLY "public"."whatsapp_sessions"
    ADD CONSTRAINT "whatsapp_sessions_pkey" PRIMARY KEY ("phone_number");



CREATE INDEX "idx_inventory_count_items_product" ON "public"."inventory_count_items" USING "btree" ("product_id");



CREATE INDEX "idx_inventory_count_items_session" ON "public"."inventory_count_items" USING "btree" ("session_id");



CREATE INDEX "idx_inventory_count_sessions_status" ON "public"."inventory_count_sessions" USING "btree" ("status", "opened_at" DESC);



CREATE INDEX "idx_product_categories_active_sort" ON "public"."product_categories" USING "btree" ("active", "sort_order", "name");



CREATE INDEX "idx_product_customer_group_prices_product" ON "public"."product_customer_group_prices" USING "btree" ("product_id", "customer_group", "active", "priority");



CREATE INDEX "idx_product_presentation_prices_product" ON "public"."product_presentation_prices" USING "btree" ("product_id", "unit_name", "customer_group", "active", "priority");



CREATE INDEX "idx_product_prices_lookup" ON "public"."product_prices" USING "btree" ("product_id", "price_list", "currency", "is_current");



CREATE INDEX "idx_product_promotions_product" ON "public"."product_promotions" USING "btree" ("product_id", "customer_group", "unit_name", "active", "priority");



CREATE INDEX "idx_product_search_index_embedding" ON "public"."product_search_index" USING "hnsw" ("embedding" "public"."vector_cosine_ops");



CREATE INDEX "idx_product_search_index_trgm" ON "public"."product_search_index" USING "gin" ("search_text" "extensions"."gin_trgm_ops");



CREATE INDEX "idx_product_search_synonyms_phrase" ON "public"."product_search_synonyms" USING "btree" ("phrase_norm") WHERE "active";



CREATE INDEX "idx_product_unit_conversions_product" ON "public"."product_unit_conversions" USING "btree" ("product_id");



CREATE INDEX "idx_product_wholesale_tiers_product" ON "public"."product_wholesale_tiers" USING "btree" ("product_id", "customer_group", "min_qty_base" DESC, "active", "priority");



CREATE INDEX "idx_products_category_id" ON "public"."products" USING "btree" ("category_id");



CREATE INDEX "idx_purchase_items_product" ON "public"."purchase_items" USING "btree" ("product_id");



CREATE INDEX "idx_purchase_items_purchase" ON "public"."purchase_items" USING "btree" ("purchase_id");



CREATE INDEX "idx_sale_cost_allocations_sale" ON "public"."sale_cost_allocations" USING "btree" ("sale_id");



CREATE INDEX "idx_sale_cost_allocations_sale_item" ON "public"."sale_cost_allocations" USING "btree" ("sale_item_id");



CREATE INDEX "idx_sale_items_product" ON "public"."sale_items" USING "btree" ("product_id");



CREATE INDEX "idx_sale_items_sale" ON "public"."sale_items" USING "btree" ("sale_id");



CREATE INDEX "idx_sales_order_items_order" ON "public"."sales_order_items" USING "btree" ("order_id");



CREATE INDEX "idx_sales_order_items_product" ON "public"."sales_order_items" USING "btree" ("product_id");



CREATE INDEX "idx_sales_orders_order_code" ON "public"."sales_orders" USING "btree" ("order_code");



CREATE INDEX "idx_sales_orders_status_created" ON "public"."sales_orders" USING "btree" ("status", "created_at" DESC);



CREATE INDEX "idx_stock_cost_layers_product_fifo" ON "public"."stock_cost_layers" USING "btree" ("product_id", "layer_date", "fifo_order");



CREATE INDEX "idx_stock_cost_layers_purchase" ON "public"."stock_cost_layers" USING "btree" ("purchase_id");



CREATE INDEX "idx_stock_movements_product" ON "public"."stock_movements" USING "btree" ("product_id");



CREATE INDEX "idx_supplier_quote_items_product" ON "public"."supplier_quote_items" USING "btree" ("product_id");



CREATE INDEX "idx_supplier_quote_items_quote" ON "public"."supplier_quote_items" USING "btree" ("quote_id");



CREATE INDEX "idx_supplier_quotes_supplier_created_at" ON "public"."supplier_quotes" USING "btree" ("supplier_id", "created_at" DESC);



CREATE INDEX "products_embedding_idx" ON "public"."products" USING "ivfflat" ("embedding" "public"."vector_cosine_ops") WITH ("lists"='50');



CREATE INDEX "sales_sold_by_idx" ON "public"."sales" USING "btree" ("sold_by");



CREATE UNIQUE INDEX "uq_product_unit_conversions_product_unit" ON "public"."product_unit_conversions" USING "btree" ("product_id", "lower"("unit_name"));



CREATE OR REPLACE TRIGGER "trg_categories_search_index" AFTER UPDATE OF "name" ON "public"."product_categories" FOR EACH ROW EXECUTE FUNCTION "public"."trg_categories_search_index"();



CREATE OR REPLACE TRIGGER "trg_products_category_guard" BEFORE INSERT OR UPDATE OF "category_id", "product_type" ON "public"."products" FOR EACH ROW EXECUTE FUNCTION "public"."products_category_guard"();



CREATE OR REPLACE TRIGGER "trg_products_search_index" AFTER INSERT OR UPDATE OF "name", "brand", "product_type", "category_id", "active" ON "public"."products" FOR EACH ROW EXECUTE FUNCTION "public"."trg_products_search_index"();



CREATE OR REPLACE TRIGGER "trg_products_unit_guard" BEFORE INSERT OR UPDATE OF "unit" ON "public"."products" FOR EACH ROW EXECUTE FUNCTION "public"."products_unit_guard"();



CREATE OR REPLACE TRIGGER "trg_sales_payment_method_guard" BEFORE INSERT OR UPDATE OF "payment_method" ON "public"."sales" FOR EACH ROW EXECUTE FUNCTION "public"."sales_payment_method_guard"();



CREATE OR REPLACE TRIGGER "trg_synonyms_search_index" AFTER INSERT OR DELETE OR UPDATE ON "public"."product_search_synonyms" FOR EACH ROW EXECUTE FUNCTION "public"."trg_synonyms_search_index"();



CREATE OR REPLACE TRIGGER "trg_update_whatsapp_last_interaction" BEFORE UPDATE ON "public"."whatsapp_sessions" FOR EACH ROW EXECUTE FUNCTION "public"."update_whatsapp_last_interaction"();



ALTER TABLE ONLY "public"."combo_workspaces"
    ADD CONSTRAINT "combo_workspaces_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."customers"
    ADD CONSTRAINT "customers_customer_group_fkey" FOREIGN KEY ("customer_group") REFERENCES "public"."customer_groups"("code") ON UPDATE CASCADE;



ALTER TABLE ONLY "public"."inventory_balances"
    ADD CONSTRAINT "inventory_balances_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."inventory_count_items"
    ADD CONSTRAINT "inventory_count_items_applied_by_fkey" FOREIGN KEY ("applied_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."inventory_count_items"
    ADD CONSTRAINT "inventory_count_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."inventory_count_items"
    ADD CONSTRAINT "inventory_count_items_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."inventory_count_sessions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."inventory_count_sessions"
    ADD CONSTRAINT "inventory_count_sessions_closed_by_fkey" FOREIGN KEY ("closed_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."inventory_count_sessions"
    ADD CONSTRAINT "inventory_count_sessions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."product_customer_group_prices"
    ADD CONSTRAINT "product_customer_group_prices_customer_group_fkey" FOREIGN KEY ("customer_group") REFERENCES "public"."customer_groups"("code") ON UPDATE CASCADE;



ALTER TABLE ONLY "public"."product_customer_group_prices"
    ADD CONSTRAINT "product_customer_group_prices_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."product_presentation_prices"
    ADD CONSTRAINT "product_presentation_prices_customer_group_fkey" FOREIGN KEY ("customer_group") REFERENCES "public"."customer_groups"("code") ON UPDATE CASCADE;



ALTER TABLE ONLY "public"."product_presentation_prices"
    ADD CONSTRAINT "product_presentation_prices_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."product_presentation_prices"
    ADD CONSTRAINT "product_presentation_prices_unit_name_fkey" FOREIGN KEY ("unit_name") REFERENCES "public"."uom_catalog"("code") ON UPDATE CASCADE;



ALTER TABLE ONLY "public"."product_prices"
    ADD CONSTRAINT "product_prices_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."product_prices"
    ADD CONSTRAINT "product_prices_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."product_promotions"
    ADD CONSTRAINT "product_promotions_customer_group_fkey" FOREIGN KEY ("customer_group") REFERENCES "public"."customer_groups"("code") ON UPDATE CASCADE;



ALTER TABLE ONLY "public"."product_promotions"
    ADD CONSTRAINT "product_promotions_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."product_promotions"
    ADD CONSTRAINT "product_promotions_unit_name_fkey" FOREIGN KEY ("unit_name") REFERENCES "public"."uom_catalog"("code") ON UPDATE CASCADE;



ALTER TABLE ONLY "public"."product_search_index"
    ADD CONSTRAINT "product_search_index_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."product_search_synonyms"
    ADD CONSTRAINT "product_search_synonyms_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."product_unit_conversions"
    ADD CONSTRAINT "product_unit_conversions_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."product_wholesale_tiers"
    ADD CONSTRAINT "product_wholesale_tiers_customer_group_fkey" FOREIGN KEY ("customer_group") REFERENCES "public"."customer_groups"("code") ON UPDATE CASCADE;



ALTER TABLE ONLY "public"."product_wholesale_tiers"
    ADD CONSTRAINT "product_wholesale_tiers_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "public"."product_categories"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."purchase_items"
    ADD CONSTRAINT "purchase_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."purchase_items"
    ADD CONSTRAINT "purchase_items_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."purchases"
    ADD CONSTRAINT "purchases_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."purchases"
    ADD CONSTRAINT "purchases_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."sale_cost_allocations"
    ADD CONSTRAINT "sale_cost_allocations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."sale_cost_allocations"
    ADD CONSTRAINT "sale_cost_allocations_layer_id_fkey" FOREIGN KEY ("layer_id") REFERENCES "public"."stock_cost_layers"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."sale_cost_allocations"
    ADD CONSTRAINT "sale_cost_allocations_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sale_cost_allocations"
    ADD CONSTRAINT "sale_cost_allocations_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sale_cost_allocations"
    ADD CONSTRAINT "sale_cost_allocations_sale_item_id_fkey" FOREIGN KEY ("sale_item_id") REFERENCES "public"."sale_items"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sale_items"
    ADD CONSTRAINT "sale_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."sale_items"
    ADD CONSTRAINT "sale_items_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sales"
    ADD CONSTRAINT "sales_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."sales"
    ADD CONSTRAINT "sales_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."sales"
    ADD CONSTRAINT "sales_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."sales_order_items"
    ADD CONSTRAINT "sales_order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."sales_orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sales_order_items"
    ADD CONSTRAINT "sales_order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."sales_orders"
    ADD CONSTRAINT "sales_orders_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."sales_orders"
    ADD CONSTRAINT "sales_orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."sales_orders"
    ADD CONSTRAINT "sales_orders_paid_sale_id_fkey" FOREIGN KEY ("paid_sale_id") REFERENCES "public"."sales"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."sales"
    ADD CONSTRAINT "sales_sold_by_fkey" FOREIGN KEY ("sold_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."school_grades"
    ADD CONSTRAINT "school_grades_institution_id_fkey" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."school_list_item_brands"
    ADD CONSTRAINT "school_list_item_brands_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "public"."school_list_items"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."school_list_item_brands"
    ADD CONSTRAINT "school_list_item_brands_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."school_list_items"
    ADD CONSTRAINT "school_list_items_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "public"."school_lists"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."school_lists"
    ADD CONSTRAINT "school_lists_grade_id_fkey" FOREIGN KEY ("grade_id") REFERENCES "public"."school_grades"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."school_lists"
    ADD CONSTRAINT "school_lists_institution_id_fkey" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."school_lists"
    ADD CONSTRAINT "school_lists_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "public"."school_sections"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."school_sections"
    ADD CONSTRAINT "school_sections_grade_id_fkey" FOREIGN KEY ("grade_id") REFERENCES "public"."school_grades"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."stock_cost_layers"
    ADD CONSTRAINT "stock_cost_layers_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."stock_cost_layers"
    ADD CONSTRAINT "stock_cost_layers_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."stock_cost_layers"
    ADD CONSTRAINT "stock_cost_layers_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."stock_cost_layers"
    ADD CONSTRAINT "stock_cost_layers_purchase_item_id_fkey" FOREIGN KEY ("purchase_item_id") REFERENCES "public"."purchase_items"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."stock_movements"
    ADD CONSTRAINT "stock_movements_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."stock_movements"
    ADD CONSTRAINT "stock_movements_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."supplier_quote_items"
    ADD CONSTRAINT "supplier_quote_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."supplier_quote_items"
    ADD CONSTRAINT "supplier_quote_items_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "public"."supplier_quotes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."supplier_quotes"
    ADD CONSTRAINT "supplier_quotes_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."supplier_quotes"
    ADD CONSTRAINT "supplier_quotes_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."whatsapp_sessions"
    ADD CONSTRAINT "whatsapp_sessions_current_order_id_fkey" FOREIGN KEY ("current_order_id") REFERENCES "public"."sales_orders"("id") ON DELETE SET NULL;



CREATE POLICY "Allow insert for all users" ON "public"."image_cache" FOR INSERT WITH CHECK (true);



CREATE POLICY "Allow insert for all users" ON "public"."match_cache" FOR INSERT WITH CHECK (true);



CREATE POLICY "Allow read for all users" ON "public"."image_cache" FOR SELECT USING (true);



CREATE POLICY "Allow read for all users" ON "public"."match_cache" FOR SELECT USING (true);



CREATE POLICY "Allow update for all users" ON "public"."image_cache" FOR UPDATE USING (true);



CREATE POLICY "Allow update for all users" ON "public"."match_cache" FOR UPDATE USING (true);



CREATE POLICY "Service role can do all on institutions" ON "public"."institutions" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Service role can do all on school_grades" ON "public"."school_grades" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Service role can do all on school_list_item_brands" ON "public"."school_list_item_brands" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Service role can do all on school_list_items" ON "public"."school_list_items" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Service role can do all on school_lists" ON "public"."school_lists" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Service role can do all on school_sections" ON "public"."school_sections" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Service role can do all on whatsapp_sessions" ON "public"."whatsapp_sessions" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."combo_workspaces" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "combo_workspaces_delete_own" ON "public"."combo_workspaces" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "combo_workspaces_insert_own" ON "public"."combo_workspaces" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "combo_workspaces_select_own" ON "public"."combo_workspaces" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "combo_workspaces_update_own" ON "public"."combo_workspaces" FOR UPDATE USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."customer_groups" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "customer_groups_delete_owner" ON "public"."customer_groups" FOR DELETE USING ("public"."is_owner"());



CREATE POLICY "customer_groups_insert_owner" ON "public"."customer_groups" FOR INSERT WITH CHECK ("public"."is_owner"());



CREATE POLICY "customer_groups_select_auth" ON "public"."customer_groups" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "customer_groups_update_owner" ON "public"."customer_groups" FOR UPDATE USING ("public"."is_owner"()) WITH CHECK ("public"."is_owner"());



ALTER TABLE "public"."customers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "customers_all_auth" ON "public"."customers" USING (("auth"."uid"() IS NOT NULL)) WITH CHECK (("auth"."uid"() IS NOT NULL));



ALTER TABLE "public"."image_cache" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."institutions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."inventory_balances" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "inventory_balances_all_auth" ON "public"."inventory_balances" USING (("auth"."uid"() IS NOT NULL)) WITH CHECK (("auth"."uid"() IS NOT NULL));



ALTER TABLE "public"."inventory_count_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "inventory_count_items_all_auth" ON "public"."inventory_count_items" USING (("auth"."uid"() IS NOT NULL)) WITH CHECK (("auth"."uid"() IS NOT NULL));



ALTER TABLE "public"."inventory_count_sessions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "inventory_count_sessions_all_auth" ON "public"."inventory_count_sessions" USING (("auth"."uid"() IS NOT NULL)) WITH CHECK (("auth"."uid"() IS NOT NULL));



ALTER TABLE "public"."match_cache" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."payment_method_catalog" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "payment_method_catalog_delete_owner" ON "public"."payment_method_catalog" FOR DELETE USING ("public"."is_owner"());



CREATE POLICY "payment_method_catalog_insert_owner" ON "public"."payment_method_catalog" FOR INSERT WITH CHECK ("public"."is_owner"());



CREATE POLICY "payment_method_catalog_select_auth" ON "public"."payment_method_catalog" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "payment_method_catalog_update_owner" ON "public"."payment_method_catalog" FOR UPDATE USING ("public"."is_owner"()) WITH CHECK ("public"."is_owner"());



ALTER TABLE "public"."product_categories" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "product_categories_delete_owner" ON "public"."product_categories" FOR DELETE USING ("public"."is_owner"());



CREATE POLICY "product_categories_insert_owner" ON "public"."product_categories" FOR INSERT WITH CHECK ("public"."is_owner"());



CREATE POLICY "product_categories_select_auth" ON "public"."product_categories" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "product_categories_update_owner" ON "public"."product_categories" FOR UPDATE USING ("public"."is_owner"()) WITH CHECK ("public"."is_owner"());



ALTER TABLE "public"."product_customer_group_prices" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "product_customer_group_prices_owner" ON "public"."product_customer_group_prices" USING ("public"."is_owner"()) WITH CHECK ("public"."is_owner"());



CREATE POLICY "product_customer_group_prices_select_auth" ON "public"."product_customer_group_prices" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



ALTER TABLE "public"."product_presentation_prices" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "product_presentation_prices_owner" ON "public"."product_presentation_prices" USING ("public"."is_owner"()) WITH CHECK ("public"."is_owner"());



CREATE POLICY "product_presentation_prices_select_auth" ON "public"."product_presentation_prices" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



ALTER TABLE "public"."product_prices" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "product_prices_all_auth" ON "public"."product_prices" USING (("auth"."uid"() IS NOT NULL)) WITH CHECK (("auth"."uid"() IS NOT NULL));



ALTER TABLE "public"."product_promotions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "product_promotions_owner" ON "public"."product_promotions" USING ("public"."is_owner"()) WITH CHECK ("public"."is_owner"());



CREATE POLICY "product_promotions_select_auth" ON "public"."product_promotions" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



ALTER TABLE "public"."product_search_index" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."product_search_synonyms" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "product_search_synonyms_read" ON "public"."product_search_synonyms" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."product_unit_conversions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "product_unit_conversions_all_auth" ON "public"."product_unit_conversions" USING (("auth"."uid"() IS NOT NULL)) WITH CHECK (("auth"."uid"() IS NOT NULL));



ALTER TABLE "public"."product_wholesale_tiers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "product_wholesale_tiers_owner" ON "public"."product_wholesale_tiers" USING ("public"."is_owner"()) WITH CHECK ("public"."is_owner"());



CREATE POLICY "product_wholesale_tiers_select_auth" ON "public"."product_wholesale_tiers" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



ALTER TABLE "public"."products" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "products_all_auth" ON "public"."products" USING (("auth"."uid"() IS NOT NULL)) WITH CHECK (("auth"."uid"() IS NOT NULL));



ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profiles_select" ON "public"."profiles" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "profiles_update_own" ON "public"."profiles" FOR UPDATE USING (("auth"."uid"() = "id"));



CREATE POLICY "profiles_update_owner" ON "public"."profiles" FOR UPDATE USING ("public"."is_owner"());



ALTER TABLE "public"."purchase_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "purchase_items_all_auth" ON "public"."purchase_items" USING (("auth"."uid"() IS NOT NULL)) WITH CHECK (("auth"."uid"() IS NOT NULL));



ALTER TABLE "public"."purchases" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "purchases_all_auth" ON "public"."purchases" USING (("auth"."uid"() IS NOT NULL)) WITH CHECK (("auth"."uid"() IS NOT NULL));



ALTER TABLE "public"."sale_cost_allocations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "sale_cost_allocations_all_auth" ON "public"."sale_cost_allocations" USING (("auth"."uid"() IS NOT NULL)) WITH CHECK (("auth"."uid"() IS NOT NULL));



ALTER TABLE "public"."sale_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "sale_items_all_auth" ON "public"."sale_items" USING (("auth"."uid"() IS NOT NULL)) WITH CHECK (("auth"."uid"() IS NOT NULL));



ALTER TABLE "public"."sales" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "sales_all_auth" ON "public"."sales" USING (("auth"."uid"() IS NOT NULL)) WITH CHECK (("auth"."uid"() IS NOT NULL));



ALTER TABLE "public"."sales_order_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "sales_order_items_all_auth" ON "public"."sales_order_items" USING (("auth"."uid"() IS NOT NULL)) WITH CHECK (("auth"."uid"() IS NOT NULL));



ALTER TABLE "public"."sales_orders" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "sales_orders_all_auth" ON "public"."sales_orders" USING (("auth"."uid"() IS NOT NULL)) WITH CHECK (("auth"."uid"() IS NOT NULL));



ALTER TABLE "public"."school_grades" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."school_list_item_brands" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."school_list_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."school_lists" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."school_sections" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."stock_cost_layers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "stock_cost_layers_all_auth" ON "public"."stock_cost_layers" USING (("auth"."uid"() IS NOT NULL)) WITH CHECK (("auth"."uid"() IS NOT NULL));



ALTER TABLE "public"."stock_movements" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "stock_movements_all_auth" ON "public"."stock_movements" USING (("auth"."uid"() IS NOT NULL)) WITH CHECK (("auth"."uid"() IS NOT NULL));



ALTER TABLE "public"."supplier_quote_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "supplier_quote_items_all_auth" ON "public"."supplier_quote_items" USING (("auth"."uid"() IS NOT NULL)) WITH CHECK (("auth"."uid"() IS NOT NULL));



ALTER TABLE "public"."supplier_quotes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "supplier_quotes_all_auth" ON "public"."supplier_quotes" USING (("auth"."uid"() IS NOT NULL)) WITH CHECK (("auth"."uid"() IS NOT NULL));



ALTER TABLE "public"."suppliers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "suppliers_all_auth" ON "public"."suppliers" USING (("auth"."uid"() IS NOT NULL)) WITH CHECK (("auth"."uid"() IS NOT NULL));



ALTER TABLE "public"."uom_catalog" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "uom_catalog_delete_owner" ON "public"."uom_catalog" FOR DELETE USING ("public"."is_owner"());



CREATE POLICY "uom_catalog_insert_owner" ON "public"."uom_catalog" FOR INSERT WITH CHECK ("public"."is_owner"());



CREATE POLICY "uom_catalog_select_auth" ON "public"."uom_catalog" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "uom_catalog_update_owner" ON "public"."uom_catalog" FOR UPDATE USING ("public"."is_owner"()) WITH CHECK ("public"."is_owner"());



ALTER TABLE "public"."whatsapp_sessions" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";









GRANT ALL ON FUNCTION "public"."halfvec_in"("cstring", "oid", integer) TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_in"("cstring", "oid", integer) TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_in"("cstring", "oid", integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_in"("cstring", "oid", integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_out"("public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_out"("public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_out"("public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_out"("public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_recv"("internal", "oid", integer) TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_recv"("internal", "oid", integer) TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_recv"("internal", "oid", integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_recv"("internal", "oid", integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_send"("public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_send"("public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_send"("public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_send"("public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_typmod_in"("cstring"[]) TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_typmod_in"("cstring"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_typmod_in"("cstring"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_typmod_in"("cstring"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec_in"("cstring", "oid", integer) TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec_in"("cstring", "oid", integer) TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec_in"("cstring", "oid", integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec_in"("cstring", "oid", integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec_out"("public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec_out"("public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec_out"("public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec_out"("public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec_recv"("internal", "oid", integer) TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec_recv"("internal", "oid", integer) TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec_recv"("internal", "oid", integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec_recv"("internal", "oid", integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec_send"("public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec_send"("public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec_send"("public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec_send"("public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec_typmod_in"("cstring"[]) TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec_typmod_in"("cstring"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec_typmod_in"("cstring"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec_typmod_in"("cstring"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_in"("cstring", "oid", integer) TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_in"("cstring", "oid", integer) TO "anon";
GRANT ALL ON FUNCTION "public"."vector_in"("cstring", "oid", integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_in"("cstring", "oid", integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_out"("public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_out"("public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_out"("public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_out"("public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_recv"("internal", "oid", integer) TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_recv"("internal", "oid", integer) TO "anon";
GRANT ALL ON FUNCTION "public"."vector_recv"("internal", "oid", integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_recv"("internal", "oid", integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_send"("public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_send"("public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_send"("public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_send"("public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_typmod_in"("cstring"[]) TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_typmod_in"("cstring"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."vector_typmod_in"("cstring"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_typmod_in"("cstring"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."array_to_halfvec"(real[], integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."array_to_halfvec"(real[], integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."array_to_halfvec"(real[], integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."array_to_halfvec"(real[], integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."array_to_sparsevec"(real[], integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."array_to_sparsevec"(real[], integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."array_to_sparsevec"(real[], integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."array_to_sparsevec"(real[], integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."array_to_vector"(real[], integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."array_to_vector"(real[], integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."array_to_vector"(real[], integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."array_to_vector"(real[], integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."array_to_halfvec"(double precision[], integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."array_to_halfvec"(double precision[], integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."array_to_halfvec"(double precision[], integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."array_to_halfvec"(double precision[], integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."array_to_sparsevec"(double precision[], integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."array_to_sparsevec"(double precision[], integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."array_to_sparsevec"(double precision[], integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."array_to_sparsevec"(double precision[], integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."array_to_vector"(double precision[], integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."array_to_vector"(double precision[], integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."array_to_vector"(double precision[], integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."array_to_vector"(double precision[], integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."array_to_halfvec"(integer[], integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."array_to_halfvec"(integer[], integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."array_to_halfvec"(integer[], integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."array_to_halfvec"(integer[], integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."array_to_sparsevec"(integer[], integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."array_to_sparsevec"(integer[], integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."array_to_sparsevec"(integer[], integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."array_to_sparsevec"(integer[], integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."array_to_vector"(integer[], integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."array_to_vector"(integer[], integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."array_to_vector"(integer[], integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."array_to_vector"(integer[], integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."array_to_halfvec"(numeric[], integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."array_to_halfvec"(numeric[], integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."array_to_halfvec"(numeric[], integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."array_to_halfvec"(numeric[], integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."array_to_sparsevec"(numeric[], integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."array_to_sparsevec"(numeric[], integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."array_to_sparsevec"(numeric[], integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."array_to_sparsevec"(numeric[], integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."array_to_vector"(numeric[], integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."array_to_vector"(numeric[], integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."array_to_vector"(numeric[], integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."array_to_vector"(numeric[], integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_to_float4"("public"."halfvec", integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_to_float4"("public"."halfvec", integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_to_float4"("public"."halfvec", integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_to_float4"("public"."halfvec", integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec"("public"."halfvec", integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec"("public"."halfvec", integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec"("public"."halfvec", integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec"("public"."halfvec", integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_to_sparsevec"("public"."halfvec", integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_to_sparsevec"("public"."halfvec", integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_to_sparsevec"("public"."halfvec", integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_to_sparsevec"("public"."halfvec", integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_to_vector"("public"."halfvec", integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_to_vector"("public"."halfvec", integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_to_vector"("public"."halfvec", integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_to_vector"("public"."halfvec", integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec_to_halfvec"("public"."sparsevec", integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec_to_halfvec"("public"."sparsevec", integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec_to_halfvec"("public"."sparsevec", integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec_to_halfvec"("public"."sparsevec", integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec"("public"."sparsevec", integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec"("public"."sparsevec", integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec"("public"."sparsevec", integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec"("public"."sparsevec", integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec_to_vector"("public"."sparsevec", integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec_to_vector"("public"."sparsevec", integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec_to_vector"("public"."sparsevec", integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec_to_vector"("public"."sparsevec", integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_to_float4"("public"."vector", integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_to_float4"("public"."vector", integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."vector_to_float4"("public"."vector", integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_to_float4"("public"."vector", integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_to_halfvec"("public"."vector", integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_to_halfvec"("public"."vector", integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."vector_to_halfvec"("public"."vector", integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_to_halfvec"("public"."vector", integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_to_sparsevec"("public"."vector", integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_to_sparsevec"("public"."vector", integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."vector_to_sparsevec"("public"."vector", integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_to_sparsevec"("public"."vector", integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."vector"("public"."vector", integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."vector"("public"."vector", integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."vector"("public"."vector", integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector"("public"."vector", integer, boolean) TO "service_role";

























































































































































































































































GRANT ALL ON FUNCTION "public"."binary_quantize"("public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."binary_quantize"("public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."binary_quantize"("public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."binary_quantize"("public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."binary_quantize"("public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."binary_quantize"("public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."binary_quantize"("public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."binary_quantize"("public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."cosine_distance"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."cosine_distance"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."cosine_distance"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."cosine_distance"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."cosine_distance"("public"."sparsevec", "public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."cosine_distance"("public"."sparsevec", "public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."cosine_distance"("public"."sparsevec", "public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."cosine_distance"("public"."sparsevec", "public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."cosine_distance"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."cosine_distance"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."cosine_distance"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."cosine_distance"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."create_purchase"("p_supplier_id" "uuid", "p_invoice_no" "text", "p_items" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."create_purchase"("p_supplier_id" "uuid", "p_invoice_no" "text", "p_items" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_purchase"("p_supplier_id" "uuid", "p_invoice_no" "text", "p_items" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."create_sale"("p_customer_id" "uuid", "p_payment_method" "text", "p_items" "jsonb", "p_sold_by" "uuid", "p_approved_by" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."create_sale"("p_customer_id" "uuid", "p_payment_method" "text", "p_items" "jsonb", "p_sold_by" "uuid", "p_approved_by" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_sale"("p_customer_id" "uuid", "p_payment_method" "text", "p_items" "jsonb", "p_sold_by" "uuid", "p_approved_by" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."create_sales_order"("p_customer_id" "uuid", "p_payment_method" "text", "p_items" "jsonb", "p_notes" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."create_sales_order"("p_customer_id" "uuid", "p_payment_method" "text", "p_items" "jsonb", "p_notes" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_sales_order"("p_customer_id" "uuid", "p_payment_method" "text", "p_items" "jsonb", "p_notes" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."customer_group_for_sale"("p_customer_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."customer_group_for_sale"("p_customer_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."customer_group_for_sale"("p_customer_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."ensure_product_category"("p_name" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."ensure_product_category"("p_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."ensure_product_category"("p_name" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."generate_sales_order_code"() TO "anon";
GRANT ALL ON FUNCTION "public"."generate_sales_order_code"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."generate_sales_order_code"() TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_accum"(double precision[], "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_accum"(double precision[], "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_accum"(double precision[], "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_accum"(double precision[], "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_add"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_add"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_add"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_add"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_avg"(double precision[]) TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_avg"(double precision[]) TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_avg"(double precision[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_avg"(double precision[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_cmp"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_cmp"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_cmp"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_cmp"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_combine"(double precision[], double precision[]) TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_combine"(double precision[], double precision[]) TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_combine"(double precision[], double precision[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_combine"(double precision[], double precision[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_concat"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_concat"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_concat"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_concat"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_eq"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_eq"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_eq"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_eq"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_ge"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_ge"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_ge"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_ge"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_gt"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_gt"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_gt"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_gt"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_l2_squared_distance"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_l2_squared_distance"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_l2_squared_distance"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_l2_squared_distance"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_le"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_le"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_le"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_le"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_lt"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_lt"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_lt"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_lt"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_mul"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_mul"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_mul"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_mul"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_ne"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_ne"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_ne"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_ne"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_negative_inner_product"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_negative_inner_product"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_negative_inner_product"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_negative_inner_product"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_spherical_distance"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_spherical_distance"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_spherical_distance"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_spherical_distance"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_sub"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_sub"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_sub"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_sub"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."hamming_distance"(bit, bit) TO "postgres";
GRANT ALL ON FUNCTION "public"."hamming_distance"(bit, bit) TO "anon";
GRANT ALL ON FUNCTION "public"."hamming_distance"(bit, bit) TO "authenticated";
GRANT ALL ON FUNCTION "public"."hamming_distance"(bit, bit) TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



GRANT ALL ON FUNCTION "public"."hnsw_bit_support"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."hnsw_bit_support"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."hnsw_bit_support"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."hnsw_bit_support"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."hnsw_halfvec_support"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."hnsw_halfvec_support"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."hnsw_halfvec_support"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."hnsw_halfvec_support"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."hnsw_sparsevec_support"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."hnsw_sparsevec_support"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."hnsw_sparsevec_support"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."hnsw_sparsevec_support"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."hnswhandler"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."hnswhandler"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."hnswhandler"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."hnswhandler"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."inner_product"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."inner_product"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."inner_product"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."inner_product"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."inner_product"("public"."sparsevec", "public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."inner_product"("public"."sparsevec", "public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."inner_product"("public"."sparsevec", "public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."inner_product"("public"."sparsevec", "public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."inner_product"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."inner_product"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."inner_product"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."inner_product"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."is_owner"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_owner"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_owner"() TO "service_role";



GRANT ALL ON FUNCTION "public"."ivfflat_bit_support"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."ivfflat_bit_support"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."ivfflat_bit_support"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."ivfflat_bit_support"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."ivfflat_halfvec_support"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."ivfflat_halfvec_support"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."ivfflat_halfvec_support"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."ivfflat_halfvec_support"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."ivfflathandler"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."ivfflathandler"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."ivfflathandler"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."ivfflathandler"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."jaccard_distance"(bit, bit) TO "postgres";
GRANT ALL ON FUNCTION "public"."jaccard_distance"(bit, bit) TO "anon";
GRANT ALL ON FUNCTION "public"."jaccard_distance"(bit, bit) TO "authenticated";
GRANT ALL ON FUNCTION "public"."jaccard_distance"(bit, bit) TO "service_role";



GRANT ALL ON FUNCTION "public"."l1_distance"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."l1_distance"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."l1_distance"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."l1_distance"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."l1_distance"("public"."sparsevec", "public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."l1_distance"("public"."sparsevec", "public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."l1_distance"("public"."sparsevec", "public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."l1_distance"("public"."sparsevec", "public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."l1_distance"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."l1_distance"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."l1_distance"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."l1_distance"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."l2_distance"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."l2_distance"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."l2_distance"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."l2_distance"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."l2_distance"("public"."sparsevec", "public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."l2_distance"("public"."sparsevec", "public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."l2_distance"("public"."sparsevec", "public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."l2_distance"("public"."sparsevec", "public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."l2_distance"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."l2_distance"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."l2_distance"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."l2_distance"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."l2_norm"("public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."l2_norm"("public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."l2_norm"("public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."l2_norm"("public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."l2_norm"("public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."l2_norm"("public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."l2_norm"("public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."l2_norm"("public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."l2_normalize"("public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."l2_normalize"("public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."l2_normalize"("public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."l2_normalize"("public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."l2_normalize"("public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."l2_normalize"("public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."l2_normalize"("public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."l2_normalize"("public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."l2_normalize"("public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."l2_normalize"("public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."l2_normalize"("public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."l2_normalize"("public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."match_products"("query_embedding" "public"."vector", "match_threshold" double precision, "match_count" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."match_products"("query_embedding" "public"."vector", "match_threshold" double precision, "match_count" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."match_products"("query_embedding" "public"."vector", "match_threshold" double precision, "match_count" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."normalize_category_code"("p_value" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."normalize_category_code"("p_value" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."normalize_category_code"("p_value" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."normalize_uom_code"("p_value" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."normalize_uom_code"("p_value" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."normalize_uom_code"("p_value" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."pay_sales_order"("p_order_id" "uuid", "p_payment_method" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."pay_sales_order"("p_order_id" "uuid", "p_payment_method" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."pay_sales_order"("p_order_id" "uuid", "p_payment_method" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."product_search_pending"("p_model" "text", "p_limit" integer, "p_all" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."product_search_pending"("p_model" "text", "p_limit" integer, "p_all" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."products_category_guard"() TO "anon";
GRANT ALL ON FUNCTION "public"."products_category_guard"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."products_category_guard"() TO "service_role";



GRANT ALL ON FUNCTION "public"."products_unit_guard"() TO "anon";
GRANT ALL ON FUNCTION "public"."products_unit_guard"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."products_unit_guard"() TO "service_role";



GRANT ALL ON FUNCTION "public"."purchase_items_sync_base_fields"() TO "anon";
GRANT ALL ON FUNCTION "public"."purchase_items_sync_base_fields"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."purchase_items_sync_base_fields"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."refresh_product_search_index"("p_product_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."refresh_product_search_index"("p_product_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."replace_product_unit_conversions"("p_product_id" "uuid", "p_items" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."replace_product_unit_conversions"("p_product_id" "uuid", "p_items" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."replace_product_unit_conversions"("p_product_id" "uuid", "p_items" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."require_uom_code"("p_value" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."require_uom_code"("p_value" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."require_uom_code"("p_value" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."resolve_payment_method_code"("p_value" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."resolve_payment_method_code"("p_value" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."resolve_payment_method_code"("p_value" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."resolve_product_uom_factor"("p_product_id" "uuid", "p_unit_name" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."resolve_product_uom_factor"("p_product_id" "uuid", "p_unit_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."resolve_product_uom_factor"("p_product_id" "uuid", "p_unit_name" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."resolve_sale_item_pricing"("p_product_id" "uuid", "p_unit_name" "text", "p_qty_uom" numeric, "p_customer_id" "uuid", "p_sale_at" timestamp with time zone) TO "anon";
GRANT ALL ON FUNCTION "public"."resolve_sale_item_pricing"("p_product_id" "uuid", "p_unit_name" "text", "p_qty_uom" numeric, "p_customer_id" "uuid", "p_sale_at" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."resolve_sale_item_pricing"("p_product_id" "uuid", "p_unit_name" "text", "p_qty_uom" numeric, "p_customer_id" "uuid", "p_sale_at" timestamp with time zone) TO "service_role";



GRANT ALL ON FUNCTION "public"."resolve_uom_code"("p_value" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."resolve_uom_code"("p_value" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."resolve_uom_code"("p_value" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."sales_payment_method_guard"() TO "anon";
GRANT ALL ON FUNCTION "public"."sales_payment_method_guard"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."sales_payment_method_guard"() TO "service_role";



GRANT ALL ON FUNCTION "public"."search_normalize"("p_value" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."search_normalize"("p_value" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."search_normalize"("p_value" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."search_products_hybrid"("p_query" "text", "p_query_embedding" "public"."vector", "p_match_count" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."search_products_hybrid"("p_query" "text", "p_query_embedding" "public"."vector", "p_match_count" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec_cmp"("public"."sparsevec", "public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec_cmp"("public"."sparsevec", "public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec_cmp"("public"."sparsevec", "public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec_cmp"("public"."sparsevec", "public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec_eq"("public"."sparsevec", "public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec_eq"("public"."sparsevec", "public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec_eq"("public"."sparsevec", "public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec_eq"("public"."sparsevec", "public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec_ge"("public"."sparsevec", "public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec_ge"("public"."sparsevec", "public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec_ge"("public"."sparsevec", "public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec_ge"("public"."sparsevec", "public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec_gt"("public"."sparsevec", "public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec_gt"("public"."sparsevec", "public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec_gt"("public"."sparsevec", "public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec_gt"("public"."sparsevec", "public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec_l2_squared_distance"("public"."sparsevec", "public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec_l2_squared_distance"("public"."sparsevec", "public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec_l2_squared_distance"("public"."sparsevec", "public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec_l2_squared_distance"("public"."sparsevec", "public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec_le"("public"."sparsevec", "public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec_le"("public"."sparsevec", "public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec_le"("public"."sparsevec", "public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec_le"("public"."sparsevec", "public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec_lt"("public"."sparsevec", "public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec_lt"("public"."sparsevec", "public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec_lt"("public"."sparsevec", "public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec_lt"("public"."sparsevec", "public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec_ne"("public"."sparsevec", "public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec_ne"("public"."sparsevec", "public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec_ne"("public"."sparsevec", "public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec_ne"("public"."sparsevec", "public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec_negative_inner_product"("public"."sparsevec", "public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec_negative_inner_product"("public"."sparsevec", "public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec_negative_inner_product"("public"."sparsevec", "public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec_negative_inner_product"("public"."sparsevec", "public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."subvector"("public"."halfvec", integer, integer) TO "postgres";
GRANT ALL ON FUNCTION "public"."subvector"("public"."halfvec", integer, integer) TO "anon";
GRANT ALL ON FUNCTION "public"."subvector"("public"."halfvec", integer, integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."subvector"("public"."halfvec", integer, integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."subvector"("public"."vector", integer, integer) TO "postgres";
GRANT ALL ON FUNCTION "public"."subvector"("public"."vector", integer, integer) TO "anon";
GRANT ALL ON FUNCTION "public"."subvector"("public"."vector", integer, integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."subvector"("public"."vector", integer, integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."trg_categories_search_index"() TO "anon";
GRANT ALL ON FUNCTION "public"."trg_categories_search_index"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trg_categories_search_index"() TO "service_role";



GRANT ALL ON FUNCTION "public"."trg_products_search_index"() TO "anon";
GRANT ALL ON FUNCTION "public"."trg_products_search_index"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trg_products_search_index"() TO "service_role";



GRANT ALL ON FUNCTION "public"."trg_synonyms_search_index"() TO "anon";
GRANT ALL ON FUNCTION "public"."trg_synonyms_search_index"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trg_synonyms_search_index"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_whatsapp_last_interaction"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_whatsapp_last_interaction"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_whatsapp_last_interaction"() TO "service_role";



GRANT ALL ON FUNCTION "public"."upsert_product_catalog"("p_id" "uuid", "p_sku" "text", "p_name" "text", "p_unit" "text", "p_brand" "text", "p_product_type" "text", "p_barcode" "text", "p_active" boolean, "p_sale_price" numeric, "p_min_stock" numeric, "p_stock_on_hand" numeric, "p_avg_cost" numeric, "p_currency" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."upsert_product_catalog"("p_id" "uuid", "p_sku" "text", "p_name" "text", "p_unit" "text", "p_brand" "text", "p_product_type" "text", "p_barcode" "text", "p_active" boolean, "p_sale_price" numeric, "p_min_stock" numeric, "p_stock_on_hand" numeric, "p_avg_cost" numeric, "p_currency" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."upsert_product_catalog"("p_id" "uuid", "p_sku" "text", "p_name" "text", "p_unit" "text", "p_brand" "text", "p_product_type" "text", "p_barcode" "text", "p_active" boolean, "p_sale_price" numeric, "p_min_stock" numeric, "p_stock_on_hand" numeric, "p_avg_cost" numeric, "p_currency" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."user_role"() TO "anon";
GRANT ALL ON FUNCTION "public"."user_role"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."user_role"() TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_accum"(double precision[], "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_accum"(double precision[], "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_accum"(double precision[], "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_accum"(double precision[], "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_add"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_add"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_add"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_add"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_avg"(double precision[]) TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_avg"(double precision[]) TO "anon";
GRANT ALL ON FUNCTION "public"."vector_avg"(double precision[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_avg"(double precision[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_cmp"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_cmp"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_cmp"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_cmp"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_combine"(double precision[], double precision[]) TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_combine"(double precision[], double precision[]) TO "anon";
GRANT ALL ON FUNCTION "public"."vector_combine"(double precision[], double precision[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_combine"(double precision[], double precision[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_concat"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_concat"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_concat"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_concat"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_dims"("public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_dims"("public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_dims"("public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_dims"("public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_dims"("public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_dims"("public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_dims"("public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_dims"("public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_eq"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_eq"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_eq"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_eq"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_ge"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_ge"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_ge"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_ge"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_gt"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_gt"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_gt"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_gt"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_l2_squared_distance"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_l2_squared_distance"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_l2_squared_distance"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_l2_squared_distance"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_le"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_le"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_le"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_le"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_lt"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_lt"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_lt"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_lt"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_mul"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_mul"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_mul"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_mul"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_ne"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_ne"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_ne"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_ne"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_negative_inner_product"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_negative_inner_product"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_negative_inner_product"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_negative_inner_product"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_norm"("public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_norm"("public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_norm"("public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_norm"("public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_spherical_distance"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_spherical_distance"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_spherical_distance"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_spherical_distance"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_sub"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_sub"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_sub"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_sub"("public"."vector", "public"."vector") TO "service_role";












GRANT ALL ON FUNCTION "public"."avg"("public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."avg"("public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."avg"("public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."avg"("public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."avg"("public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."avg"("public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."avg"("public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."avg"("public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."sum"("public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."sum"("public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."sum"("public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sum"("public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."sum"("public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."sum"("public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."sum"("public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sum"("public"."vector") TO "service_role";









GRANT ALL ON TABLE "public"."combo_workspaces" TO "anon";
GRANT ALL ON TABLE "public"."combo_workspaces" TO "authenticated";
GRANT ALL ON TABLE "public"."combo_workspaces" TO "service_role";



GRANT ALL ON TABLE "public"."customer_groups" TO "anon";
GRANT ALL ON TABLE "public"."customer_groups" TO "authenticated";
GRANT ALL ON TABLE "public"."customer_groups" TO "service_role";



GRANT ALL ON TABLE "public"."customers" TO "anon";
GRANT ALL ON TABLE "public"."customers" TO "authenticated";
GRANT ALL ON TABLE "public"."customers" TO "service_role";



GRANT ALL ON TABLE "public"."image_cache" TO "anon";
GRANT ALL ON TABLE "public"."image_cache" TO "authenticated";
GRANT ALL ON TABLE "public"."image_cache" TO "service_role";



GRANT ALL ON TABLE "public"."import_batches" TO "anon";
GRANT ALL ON TABLE "public"."import_batches" TO "authenticated";
GRANT ALL ON TABLE "public"."import_batches" TO "service_role";



GRANT ALL ON TABLE "public"."institutions" TO "anon";
GRANT ALL ON TABLE "public"."institutions" TO "authenticated";
GRANT ALL ON TABLE "public"."institutions" TO "service_role";



GRANT ALL ON TABLE "public"."inventory_balances" TO "anon";
GRANT ALL ON TABLE "public"."inventory_balances" TO "authenticated";
GRANT ALL ON TABLE "public"."inventory_balances" TO "service_role";



GRANT ALL ON TABLE "public"."inventory_count_items" TO "anon";
GRANT ALL ON TABLE "public"."inventory_count_items" TO "authenticated";
GRANT ALL ON TABLE "public"."inventory_count_items" TO "service_role";



GRANT ALL ON TABLE "public"."inventory_count_sessions" TO "anon";
GRANT ALL ON TABLE "public"."inventory_count_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."inventory_count_sessions" TO "service_role";



GRANT ALL ON TABLE "public"."match_cache" TO "anon";
GRANT ALL ON TABLE "public"."match_cache" TO "authenticated";
GRANT ALL ON TABLE "public"."match_cache" TO "service_role";



GRANT ALL ON TABLE "public"."payment_method_catalog" TO "anon";
GRANT ALL ON TABLE "public"."payment_method_catalog" TO "authenticated";
GRANT ALL ON TABLE "public"."payment_method_catalog" TO "service_role";



GRANT ALL ON TABLE "public"."product_categories" TO "anon";
GRANT ALL ON TABLE "public"."product_categories" TO "authenticated";
GRANT ALL ON TABLE "public"."product_categories" TO "service_role";



GRANT ALL ON TABLE "public"."product_prices" TO "anon";
GRANT ALL ON TABLE "public"."product_prices" TO "authenticated";
GRANT ALL ON TABLE "public"."product_prices" TO "service_role";



GRANT ALL ON TABLE "public"."product_unit_conversions" TO "anon";
GRANT ALL ON TABLE "public"."product_unit_conversions" TO "authenticated";
GRANT ALL ON TABLE "public"."product_unit_conversions" TO "service_role";



GRANT ALL ON TABLE "public"."products" TO "anon";
GRANT ALL ON TABLE "public"."products" TO "authenticated";
GRANT ALL ON TABLE "public"."products" TO "service_role";



GRANT ALL ON TABLE "public"."purchase_items" TO "anon";
GRANT ALL ON TABLE "public"."purchase_items" TO "authenticated";
GRANT ALL ON TABLE "public"."purchase_items" TO "service_role";



GRANT ALL ON TABLE "public"."purchases" TO "anon";
GRANT ALL ON TABLE "public"."purchases" TO "authenticated";
GRANT ALL ON TABLE "public"."purchases" TO "service_role";



GRANT ALL ON TABLE "public"."sale_items" TO "anon";
GRANT ALL ON TABLE "public"."sale_items" TO "authenticated";
GRANT ALL ON TABLE "public"."sale_items" TO "service_role";



GRANT ALL ON TABLE "public"."sales" TO "anon";
GRANT ALL ON TABLE "public"."sales" TO "authenticated";
GRANT ALL ON TABLE "public"."sales" TO "service_role";



GRANT ALL ON TABLE "public"."product_catalog" TO "anon";
GRANT ALL ON TABLE "public"."product_catalog" TO "authenticated";
GRANT ALL ON TABLE "public"."product_catalog" TO "service_role";



GRANT ALL ON TABLE "public"."product_customer_group_prices" TO "anon";
GRANT ALL ON TABLE "public"."product_customer_group_prices" TO "authenticated";
GRANT ALL ON TABLE "public"."product_customer_group_prices" TO "service_role";



GRANT ALL ON TABLE "public"."product_presentation_prices" TO "anon";
GRANT ALL ON TABLE "public"."product_presentation_prices" TO "authenticated";
GRANT ALL ON TABLE "public"."product_presentation_prices" TO "service_role";



GRANT ALL ON TABLE "public"."product_promotions" TO "anon";
GRANT ALL ON TABLE "public"."product_promotions" TO "authenticated";
GRANT ALL ON TABLE "public"."product_promotions" TO "service_role";



GRANT ALL ON TABLE "public"."product_search_index" TO "anon";
GRANT ALL ON TABLE "public"."product_search_index" TO "authenticated";
GRANT ALL ON TABLE "public"."product_search_index" TO "service_role";



GRANT ALL ON TABLE "public"."product_search_synonyms" TO "anon";
GRANT ALL ON TABLE "public"."product_search_synonyms" TO "authenticated";
GRANT ALL ON TABLE "public"."product_search_synonyms" TO "service_role";



GRANT ALL ON TABLE "public"."product_wholesale_tiers" TO "anon";
GRANT ALL ON TABLE "public"."product_wholesale_tiers" TO "authenticated";
GRANT ALL ON TABLE "public"."product_wholesale_tiers" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."sale_cost_allocations" TO "anon";
GRANT ALL ON TABLE "public"."sale_cost_allocations" TO "authenticated";
GRANT ALL ON TABLE "public"."sale_cost_allocations" TO "service_role";



GRANT ALL ON TABLE "public"."sales_order_items" TO "anon";
GRANT ALL ON TABLE "public"."sales_order_items" TO "authenticated";
GRANT ALL ON TABLE "public"."sales_order_items" TO "service_role";



GRANT ALL ON TABLE "public"."sales_orders" TO "anon";
GRANT ALL ON TABLE "public"."sales_orders" TO "authenticated";
GRANT ALL ON TABLE "public"."sales_orders" TO "service_role";



GRANT ALL ON TABLE "public"."school_grades" TO "anon";
GRANT ALL ON TABLE "public"."school_grades" TO "authenticated";
GRANT ALL ON TABLE "public"."school_grades" TO "service_role";



GRANT ALL ON TABLE "public"."school_list_item_brands" TO "anon";
GRANT ALL ON TABLE "public"."school_list_item_brands" TO "authenticated";
GRANT ALL ON TABLE "public"."school_list_item_brands" TO "service_role";



GRANT ALL ON TABLE "public"."school_list_items" TO "anon";
GRANT ALL ON TABLE "public"."school_list_items" TO "authenticated";
GRANT ALL ON TABLE "public"."school_list_items" TO "service_role";



GRANT ALL ON TABLE "public"."school_lists" TO "anon";
GRANT ALL ON TABLE "public"."school_lists" TO "authenticated";
GRANT ALL ON TABLE "public"."school_lists" TO "service_role";



GRANT ALL ON TABLE "public"."school_sections" TO "anon";
GRANT ALL ON TABLE "public"."school_sections" TO "authenticated";
GRANT ALL ON TABLE "public"."school_sections" TO "service_role";



GRANT ALL ON TABLE "public"."stg_compras_ayrampo_import" TO "anon";
GRANT ALL ON TABLE "public"."stg_compras_ayrampo_import" TO "authenticated";
GRANT ALL ON TABLE "public"."stg_compras_ayrampo_import" TO "service_role";



GRANT ALL ON TABLE "public"."stg_compras_tania_import" TO "anon";
GRANT ALL ON TABLE "public"."stg_compras_tania_import" TO "authenticated";
GRANT ALL ON TABLE "public"."stg_compras_tania_import" TO "service_role";



GRANT ALL ON TABLE "public"."stg_productos_import" TO "anon";
GRANT ALL ON TABLE "public"."stg_productos_import" TO "authenticated";
GRANT ALL ON TABLE "public"."stg_productos_import" TO "service_role";



GRANT ALL ON TABLE "public"."stg_stock_actual_hoja2_import" TO "anon";
GRANT ALL ON TABLE "public"."stg_stock_actual_hoja2_import" TO "authenticated";
GRANT ALL ON TABLE "public"."stg_stock_actual_hoja2_import" TO "service_role";



GRANT ALL ON TABLE "public"."stg_ventas_hoja2_import" TO "anon";
GRANT ALL ON TABLE "public"."stg_ventas_hoja2_import" TO "authenticated";
GRANT ALL ON TABLE "public"."stg_ventas_hoja2_import" TO "service_role";



GRANT ALL ON TABLE "public"."stg_ventas_hoja2_zero_import" TO "anon";
GRANT ALL ON TABLE "public"."stg_ventas_hoja2_zero_import" TO "authenticated";
GRANT ALL ON TABLE "public"."stg_ventas_hoja2_zero_import" TO "service_role";



GRANT ALL ON TABLE "public"."stock_cost_layers" TO "anon";
GRANT ALL ON TABLE "public"."stock_cost_layers" TO "authenticated";
GRANT ALL ON TABLE "public"."stock_cost_layers" TO "service_role";



GRANT ALL ON SEQUENCE "public"."stock_cost_layers_fifo_order_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."stock_cost_layers_fifo_order_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."stock_cost_layers_fifo_order_seq" TO "service_role";



GRANT ALL ON TABLE "public"."stock_movements" TO "anon";
GRANT ALL ON TABLE "public"."stock_movements" TO "authenticated";
GRANT ALL ON TABLE "public"."stock_movements" TO "service_role";



GRANT ALL ON TABLE "public"."supplier_quote_items" TO "anon";
GRANT ALL ON TABLE "public"."supplier_quote_items" TO "authenticated";
GRANT ALL ON TABLE "public"."supplier_quote_items" TO "service_role";



GRANT ALL ON TABLE "public"."supplier_quotes" TO "anon";
GRANT ALL ON TABLE "public"."supplier_quotes" TO "authenticated";
GRANT ALL ON TABLE "public"."supplier_quotes" TO "service_role";



GRANT ALL ON TABLE "public"."suppliers" TO "anon";
GRANT ALL ON TABLE "public"."suppliers" TO "authenticated";
GRANT ALL ON TABLE "public"."suppliers" TO "service_role";



GRANT ALL ON TABLE "public"."uom_catalog" TO "anon";
GRANT ALL ON TABLE "public"."uom_catalog" TO "authenticated";
GRANT ALL ON TABLE "public"."uom_catalog" TO "service_role";



GRANT ALL ON TABLE "public"."whatsapp_sessions" TO "anon";
GRANT ALL ON TABLE "public"."whatsapp_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."whatsapp_sessions" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";

































-- Trigger propio sobre auth.users (no viene en el dump de "public"; tomado del esquema auth de producción).
CREATE OR REPLACE TRIGGER "on_auth_user_created" AFTER INSERT ON "auth"."users" FOR EACH ROW EXECUTE FUNCTION "public"."handle_new_user"();
