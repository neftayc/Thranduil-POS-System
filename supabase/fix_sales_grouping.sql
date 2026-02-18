-- Este script corrige la importación de ventas para agrupar productos por sale_ref
-- en lugar de crear una venta separada por cada producto

begin;

-- 1. Limpiar ventas importadas anteriormente
delete from public.stock_movements sm
using public.sales s
join public.customers c on c.id = s.customer_id
where sm.ref_table = 'sales'
  and sm.ref_id = s.id
  and s.payment_method = 'IMPORT-HOJA2'
  and lower(c.name) = lower('clients-2025');

delete from public.sale_items si
using public.sales s
join public.customers c on c.id = s.customer_id
where si.sale_id = s.id
  and s.payment_method = 'IMPORT-HOJA2'
  and lower(c.name) = lower('clients-2025');

delete from public.sales s
using public.customers c
where s.customer_id = c.id
  and s.payment_method = 'IMPORT-HOJA2'
  and lower(c.name) = lower('clients-2025');

-- 2. Reimportar ventas AGRUPADAS por sale_ref
do $$
declare
  v_customer_id uuid;
  v_sale_ref_rec record;
  v_item_rec record;
  v_sale_id uuid;
  v_product_id uuid;
  v_sale_date timestamptz;
  v_sale_total numeric;
begin
  -- Obtener el cliente único
  select c.id into v_customer_id
  from public.customers c
  where lower(c.name) = lower('clients-2025')
  limit 1;

  if v_customer_id is null then
    raise exception 'No se encontró el cliente clients-2025';
  end if;

  -- Iterar por cada sale_ref (cada transacción única)
  for v_sale_ref_rec in
    select
      coalesce(sale_ref, 'SIN-REF-' || product_sku) as sale_ref,
      weeks,
      sum(coalesce(line_total, 0)) as total_venta
    from public.stg_ventas_hoja2_import
    where coalesce(qty, 0) > 0
      and coalesce(line_total, 0) > 0
    group by coalesce(sale_ref, 'SIN-REF-' || product_sku), weeks
    order by coalesce(sale_ref, 'SIN-REF-' || product_sku)
  loop
    -- Determinar fecha según semana
    v_sale_date := case
      when coalesce(v_sale_ref_rec.weeks, '') ilike '%SEMANA-1%' then timestamptz '2025-01-08 12:00:00-05'
      when coalesce(v_sale_ref_rec.weeks, '') ilike '%SEMANA-2%' then timestamptz '2025-01-15 12:00:00-05'
      when coalesce(v_sale_ref_rec.weeks, '') ilike '%SEMANA-3%' then timestamptz '2025-01-22 12:00:00-05'
      else now()
    end;

    -- Crear UNA venta por sale_ref
    insert into public.sales (
      customer_id,
      sale_date,
      total,
      payment_method,
      created_at
    )
    values (
      v_customer_id,
      v_sale_date,
      round(v_sale_ref_rec.total_venta, 2),
      'IMPORT-HOJA2',
      v_sale_date
    )
    returning id into v_sale_id;

    -- Agregar TODOS los productos de esta venta
    for v_item_rec in
      select
        product_sku,
        qty,
        price_unit,
        line_total,
        cost_total
      from public.stg_ventas_hoja2_import
      where coalesce(sale_ref, 'SIN-REF-' || product_sku) = v_sale_ref_rec.sale_ref
        and coalesce(qty, 0) > 0
        and coalesce(line_total, 0) > 0
    loop
      -- Buscar el producto
      select p.id into v_product_id
      from public.products p
      where p.sku = trim(v_item_rec.product_sku)
      limit 1;

      if v_product_id is null then
        raise notice 'Producto no encontrado, omitiendo: %', v_item_rec.product_sku;
        continue;
      end if;

      -- Insertar item de venta
      insert into public.sale_items (
        sale_id,
        product_id,
        qty,
        price_unit,
        total,
        created_at
      )
      values (
        v_sale_id,
        v_product_id,
        v_item_rec.qty,
        round(coalesce(v_item_rec.price_unit, 0), 2),
        round(coalesce(v_item_rec.line_total, 0), 2),
        v_sale_date
      );

      -- Crear movimiento de stock
      insert into public.stock_movements (
        product_id,
        movement_type,
        qty,
        cost_unit,
        ref_table,
        ref_id,
        created_at
      )
      values (
        v_product_id,
        'sale',
        -v_item_rec.qty,
        case
          when v_item_rec.qty > 0 then coalesce(v_item_rec.cost_total, 0) / v_item_rec.qty
          else null
        end,
        'sales',
        v_sale_id,
        v_sale_date
      );
    end loop;

    raise notice 'Venta creada: % con % items, Total: S/ %',
      v_sale_ref_rec.sale_ref,
      (select count(*) from public.sale_items where sale_id = v_sale_id),
      v_sale_ref_rec.total_venta;
  end loop;
end $$;

commit;

-- Verificación
select
  s.id,
  s.sale_date,
  s.total,
  count(si.id) as num_items
from public.sales s
left join public.sale_items si on si.sale_id = s.id
where s.payment_method = 'IMPORT-HOJA2'
group by s.id, s.sale_date, s.total
order by s.sale_date desc
limit 20;
