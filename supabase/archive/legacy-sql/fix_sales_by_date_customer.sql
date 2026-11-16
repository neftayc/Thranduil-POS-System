-- Script para reagrupar ventas por fecha (semana) + cliente
-- Esto creará UNA venta por cada combinación de semana + cliente
-- con MÚLTIPLES productos en cada venta

begin;

-- 1. Limpiar ventas importadas
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

-- 2. Reagrupar ventas por SEMANA + CLIENTE
do $$
declare
  v_customer_id uuid;
  v_group_rec record;
  v_item_rec record;
  v_sale_id uuid;
  v_product_id uuid;
  v_sale_date timestamptz;
  v_group_total numeric;
begin
  -- Obtener el cliente único
  select c.id into v_customer_id
  from public.customers c
  where lower(c.name) = lower('clients-2025')
  limit 1;

  if v_customer_id is null then
    raise exception 'No se encontró el cliente clients-2025';
  end if;

  -- Iterar por cada grupo de SEMANA + CLIENTE
  for v_group_rec in
    select
      coalesce(weeks, 'SIN-SEMANA') as week_group,
      coalesce(customer_code, 'SIN-CODIGO') as customer_code,
      coalesce(customer_name, 'SIN-NOMBRE') as customer_name,
      sum(coalesce(line_total, 0)) as total_venta,
      count(*) as num_productos
    from public.stg_ventas_hoja2_import
    where coalesce(qty, 0) > 0
      and coalesce(line_total, 0) > 0
    group by 
      coalesce(weeks, 'SIN-SEMANA'),
      coalesce(customer_code, 'SIN-CODIGO'),
      coalesce(customer_name, 'SIN-NOMBRE')
    order by week_group, customer_code
  loop
    -- Determinar fecha según semana
    v_sale_date := case
      when v_group_rec.week_group ilike '%SEMANA-1%' then timestamptz '2025-01-08 12:00:00-05'
      when v_group_rec.week_group ilike '%SEMANA-2%' then timestamptz '2025-01-15 12:00:00-05'
      when v_group_rec.week_group ilike '%SEMANA-3%' then timestamptz '2025-01-22 12:00:00-05'
      else now()
    end;

    -- Crear UNA venta por grupo (semana + cliente)
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
      round(v_group_rec.total_venta, 2),
      'IMPORT-HOJA2',
      v_sale_date
    )
    returning id into v_sale_id;

    -- Agregar TODOS los productos de este grupo (semana + cliente)
    for v_item_rec in
      select
        product_sku,
        sum(qty) as qty_total,
        avg(price_unit) as price_avg,
        sum(line_total) as line_total_sum,
        sum(cost_total) as cost_total_sum
      from public.stg_ventas_hoja2_import
      where coalesce(weeks, 'SIN-SEMANA') = v_group_rec.week_group
        and coalesce(customer_code, 'SIN-CODIGO') = v_group_rec.customer_code
        and coalesce(qty, 0) > 0
        and coalesce(line_total, 0) > 0
      group by product_sku
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
        v_item_rec.qty_total,
        round(coalesce(v_item_rec.price_avg, 0), 2),
        round(coalesce(v_item_rec.line_total_sum, 0), 2),
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
        -v_item_rec.qty_total,
        case
          when v_item_rec.qty_total > 0 then coalesce(v_item_rec.cost_total_sum, 0) / v_item_rec.qty_total
          else null
        end,
        'sales',
        v_sale_id,
        v_sale_date
      );
    end loop;

    raise notice 'Venta creada para % - %: % productos, Total: S/ %',
      v_group_rec.week_group,
      v_group_rec.customer_name,
      v_group_rec.num_productos,
      v_group_rec.total_venta;
  end loop;
end $$;

commit;

-- Verificación: Ver ventas agrupadas
select
  s.sale_date,
  c.name as customer,
  s.total,
  count(si.id) as num_items,
  string_agg(p.name, ', ') as productos
from public.sales s
left join public.sale_items si on si.sale_id = s.id
left join public.products p on p.id = si.product_id
left join public.customers c on c.id = s.customer_id
where s.payment_method = 'IMPORT-HOJA2'
group by s.id, s.sale_date, c.name, s.total
order by s.sale_date, num_items desc;
