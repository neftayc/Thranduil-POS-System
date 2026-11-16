begin;

-- -------------------------------------------------------------------
-- 0) Validaciones de staging
-- -------------------------------------------------------------------
do $$
declare
  v_prod int;
  v_tania int;
  v_ayrampo int;
  v_sales int;
  v_stock int;
begin
  select count(*) into v_prod from public.stg_productos_import;
  select count(*) into v_tania from public.stg_compras_tania_import;
  select count(*) into v_ayrampo from public.stg_compras_ayrampo_import;
  select count(*) into v_sales from public.stg_ventas_hoja2_import;
  select count(*) into v_stock from public.stg_stock_actual_hoja2_import;

  if v_prod = 0 then
    raise exception 'stg_productos_import esta vacia';
  end if;
  if v_tania = 0 then
    raise exception 'stg_compras_tania_import esta vacia';
  end if;
  if v_ayrampo = 0 then
    raise exception 'stg_compras_ayrampo_import esta vacia';
  end if;
  if v_sales = 0 then
    raise exception 'stg_ventas_hoja2_import esta vacia';
  end if;
  if v_stock = 0 then
    raise exception 'stg_stock_actual_hoja2_import esta vacia';
  end if;
end $$;

-- -------------------------------------------------------------------
-- 1) Catalogo de productos
-- -------------------------------------------------------------------
insert into public.products (
  sku,
  name,
  product_type,
  brand,
  unit,
  active,
  sale_price,
  min_stock,
  updated_at
)
select
  trim(sp.sku) as sku,
  trim(sp.producto) as name,
  nullif(trim(sp.tipo), ''),
  nullif(trim(sp.marca), ''),
  coalesce(nullif(trim(sp.unidad), ''), 'unidad'),
  true,
  coalesce(sp.precio_venta_referencia, 0)::numeric,
  0,
  now()
from public.stg_productos_import sp
where coalesce(trim(sp.sku), '') <> ''
  and coalesce(trim(sp.producto), '') <> ''
on conflict (sku)
do update set
  name = excluded.name,
  product_type = excluded.product_type,
  brand = excluded.brand,
  unit = excluded.unit,
  active = excluded.active,
  sale_price = excluded.sale_price,
  updated_at = now();

-- Balance inicial (avg_cost desde costo_referencia; stock se corrige con snapshot Hoja 2)
insert into public.inventory_balances (
  product_id,
  stock_on_hand,
  avg_cost,
  min_stock,
  updated_at
)
select
  p.id,
  coalesce(ib.stock_on_hand, 0),
  case
    when coalesce(sp.costo_referencia, 0) > 0 then sp.costo_referencia
    else coalesce(ib.avg_cost, 0)
  end as avg_cost,
  coalesce(ib.min_stock, 0),
  now()
from public.stg_productos_import sp
join public.products p on p.sku = trim(sp.sku)
left join public.inventory_balances ib on ib.product_id = p.id
on conflict (product_id)
do update set
  avg_cost = case
    when excluded.avg_cost > 0 then excluded.avg_cost
    else public.inventory_balances.avg_cost
  end,
  updated_at = now();

-- Precio retail actual
update public.product_prices pp
set is_current = false,
    valid_to = coalesce(pp.valid_to, now())
from public.stg_productos_import sp
join public.products p on p.sku = trim(sp.sku)
where pp.product_id = p.id
  and pp.price_list = 'retail'
  and pp.currency = 'PEN'
  and pp.is_current = true;

insert into public.product_prices (
  product_id,
  price_list,
  regular_price,
  sale_price,
  currency,
  valid_from,
  is_current,
  created_at
)
select
  p.id,
  'retail',
  coalesce(sp.precio_venta_referencia, 0)::numeric,
  coalesce(sp.precio_venta_referencia, 0)::numeric,
  'PEN',
  now(),
  true,
  now()
from public.stg_productos_import sp
join public.products p on p.sku = trim(sp.sku);

update public.products p
set sale_price = pp.sale_price,
    updated_at = now()
from public.product_prices pp
where pp.product_id = p.id
  and pp.price_list = 'retail'
  and pp.currency = 'PEN'
  and pp.is_current = true;

-- -------------------------------------------------------------------
-- 2) Limpieza de importaciones anteriores (solo import)
-- -------------------------------------------------------------------
delete from public.stock_movements sm
using public.purchases p
where sm.ref_table = 'purchases'
  and sm.ref_id = p.id
  and p.invoice_no in (
    'IMPORT-TANIA-YUCRA-001',
    'IMPORT-EMPRESA-AYRAMPO-001',
    'IMPORT-HOJA1-TANIA-YUCRA-001',
    'IMPORT-HOJA1-EMPRESA-AYRAMPO-001'
  );

delete from public.purchase_items pi
using public.purchases p
where pi.purchase_id = p.id
  and p.invoice_no in (
    'IMPORT-TANIA-YUCRA-001',
    'IMPORT-EMPRESA-AYRAMPO-001',
    'IMPORT-HOJA1-TANIA-YUCRA-001',
    'IMPORT-HOJA1-EMPRESA-AYRAMPO-001'
  );

delete from public.purchases
where invoice_no in (
  'IMPORT-TANIA-YUCRA-001',
  'IMPORT-EMPRESA-AYRAMPO-001',
  'IMPORT-HOJA1-TANIA-YUCRA-001',
  'IMPORT-HOJA1-EMPRESA-AYRAMPO-001'
);

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

-- -------------------------------------------------------------------
-- 3) Proveedores + Compras corregidas (Hoja 1)
-- -------------------------------------------------------------------
insert into public.suppliers (name)
select x.name
from (values ('Tania Yucra'), ('Empresa Ayrampo')) as x(name)
where not exists (
  select 1
  from public.suppliers s
  where lower(s.name) = lower(x.name)
);

insert into public.purchases (
  supplier_id,
  invoice_no,
  purchase_date,
  total_cost,
  created_at
)
select s.id, 'IMPORT-HOJA1-TANIA-YUCRA-001', now(), 0, now()
from public.suppliers s
where lower(s.name) = lower('Tania Yucra');

insert into public.purchases (
  supplier_id,
  invoice_no,
  purchase_date,
  total_cost,
  created_at
)
select s.id, 'IMPORT-HOJA1-EMPRESA-AYRAMPO-001', now(), 0, now()
from public.suppliers s
where lower(s.name) = lower('Empresa Ayrampo');

insert into public.purchase_items (
  purchase_id,
  product_id,
  unit_name,
  qty_uom,
  factor_to_base,
  cost_unit_uom,
  qty,
  cost_unit,
  total_cost,
  created_at
)
select
  p.id,
  pr.id,
  u.unit_code as unit_name,
  st.qty as qty_uom,
  f.factor_to_base,
  case
    when st.qty > 0 then coalesce(st.total_cost, 0) / st.qty
    else 0
  end as cost_unit_uom,
  st.qty * f.factor_to_base,
  case
    when st.qty > 0 and f.factor_to_base > 0 then (coalesce(st.total_cost, 0) / st.qty) / f.factor_to_base
    else 0
  end as cost_unit,
  coalesce(st.total_cost, 0),
  now()
from public.stg_compras_tania_import st
join public.products pr on pr.sku = trim(st.product_sku)
join public.purchases p on p.invoice_no = 'IMPORT-HOJA1-TANIA-YUCRA-001'
join lateral (
  select
    coalesce(public.resolve_uom_code(st.unit), public.normalize_uom_code(st.unit), 'unidad') as unit_code,
    coalesce(public.resolve_uom_code(pr.unit), public.normalize_uom_code(pr.unit), 'unidad') as base_unit_code
) u on true
left join public.product_unit_conversions puc
  on puc.product_id = pr.id
 and lower(puc.unit_name) = lower(u.unit_code)
 and puc.is_active = true
join lateral (
  select case
    when u.unit_code = u.base_unit_code then 1::numeric
    when coalesce(puc.factor_to_base, 0) > 0 then puc.factor_to_base
    else 1::numeric
  end as factor_to_base
) f on true
where coalesce(st.qty, 0) > 0;

insert into public.purchase_items (
  purchase_id,
  product_id,
  unit_name,
  qty_uom,
  factor_to_base,
  cost_unit_uom,
  qty,
  cost_unit,
  total_cost,
  created_at
)
select
  p.id,
  pr.id,
  u.unit_code as unit_name,
  st.qty as qty_uom,
  f.factor_to_base,
  case
    when st.qty > 0 then coalesce(st.total_cost, 0) / st.qty
    else 0
  end as cost_unit_uom,
  st.qty * f.factor_to_base,
  case
    when st.qty > 0 and f.factor_to_base > 0 then (coalesce(st.total_cost, 0) / st.qty) / f.factor_to_base
    else 0
  end as cost_unit,
  coalesce(st.total_cost, 0),
  now()
from public.stg_compras_ayrampo_import st
join public.products pr on pr.sku = trim(st.product_sku)
join public.purchases p on p.invoice_no = 'IMPORT-HOJA1-EMPRESA-AYRAMPO-001'
join lateral (
  select
    coalesce(public.resolve_uom_code(st.unit), public.normalize_uom_code(st.unit), 'unidad') as unit_code,
    coalesce(public.resolve_uom_code(pr.unit), public.normalize_uom_code(pr.unit), 'unidad') as base_unit_code
) u on true
left join public.product_unit_conversions puc
  on puc.product_id = pr.id
 and lower(puc.unit_name) = lower(u.unit_code)
 and puc.is_active = true
join lateral (
  select case
    when u.unit_code = u.base_unit_code then 1::numeric
    when coalesce(puc.factor_to_base, 0) > 0 then puc.factor_to_base
    else 1::numeric
  end as factor_to_base
) f on true
where coalesce(st.qty, 0) > 0;

update public.purchases p
set total_cost = x.total_cost
from (
  select pi.purchase_id, sum(pi.total_cost) as total_cost
  from public.purchase_items pi
  group by pi.purchase_id
) x
where p.id = x.purchase_id
  and p.invoice_no in (
    'IMPORT-HOJA1-TANIA-YUCRA-001',
    'IMPORT-HOJA1-EMPRESA-AYRAMPO-001'
  );

insert into public.stock_movements (
  product_id,
  movement_type,
  qty,
  cost_unit,
  ref_table,
  ref_id,
  created_at
)
select
  pi.product_id,
  'purchase',
  pi.qty,
  pi.cost_unit,
  'purchases',
  pi.purchase_id,
  now()
from public.purchase_items pi
join public.purchases p on p.id = pi.purchase_id
where p.invoice_no in (
  'IMPORT-HOJA1-TANIA-YUCRA-001',
  'IMPORT-HOJA1-EMPRESA-AYRAMPO-001'
);

-- -------------------------------------------------------------------
-- 4) Cliente unico + Ventas agrupadas (Hoja 2)
-- -------------------------------------------------------------------
insert into public.customers (name, notes)
select 'clients-2025', 'Cliente unico para import de ventas Hoja 2'
where not exists (
  select 1 from public.customers c where lower(c.name) = lower('clients-2025')
);

do $$
declare
  v_row record;
  v_customer_id uuid;
  v_product_id uuid;
  v_sale_id uuid;
  v_sale_date timestamptz;
  v_price numeric;
  v_line_total numeric;
  v_cost_unit numeric;
begin
  select c.id
    into v_customer_id
    from public.customers c
    where lower(c.name) = lower('clients-2025')
    order by c.created_at
    limit 1;

  if v_customer_id is null then
    raise exception 'No se encontro o creo el cliente clients-2025';
  end if;

  for v_row in
    select *
    from public.stg_ventas_hoja2_import s
    where coalesce(s.qty, 0) > 0
      and coalesce(s.line_total, 0) > 0
    order by coalesce(s.sale_ref, s.product_sku)
  loop
    select p.id into v_product_id
    from public.products p
    where p.sku = trim(v_row.product_sku)
    limit 1;

    if v_product_id is null then
      raise notice 'Venta omitida por SKU inexistente: % (%).', v_row.product_sku, v_row.product_name;
      continue;
    end if;

    v_sale_date := case
      when coalesce(v_row.weeks, '') ilike '%SEMANA-1%' then timestamptz '2025-01-08 12:00:00-05'
      when coalesce(v_row.weeks, '') ilike '%SEMANA-2%' then timestamptz '2025-01-15 12:00:00-05'
      when coalesce(v_row.weeks, '') ilike '%SEMANA-3%' then timestamptz '2025-01-22 12:00:00-05'
      else now()
    end;

    v_price := round(coalesce(v_row.price_unit, 0)::numeric, 2);
    v_line_total := round(coalesce(v_row.line_total, 0)::numeric, 2);
    v_cost_unit := case
      when coalesce(v_row.qty, 0) > 0 then coalesce(v_row.cost_total, 0) / v_row.qty
      else null
    end;

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
      v_line_total,
      'IMPORT-HOJA2',
      now()
    )
    returning id into v_sale_id;

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
      v_row.qty,
      v_price,
      v_line_total,
      now()
    );

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
      -v_row.qty,
      v_cost_unit,
      'sales',
      v_sale_id,
      now()
    );
  end loop;
end $$;

-- -------------------------------------------------------------------
-- 5) Snapshot de stock actual (Hoja 2) como fuente final de inventario
-- -------------------------------------------------------------------
insert into public.inventory_balances (
  product_id,
  stock_on_hand,
  avg_cost,
  min_stock,
  updated_at
)
select
  p.id,
  coalesce(ss.stock_current, 0),
  coalesce(ib.avg_cost, 0),
  coalesce(ib.min_stock, 0),
  now()
from public.stg_stock_actual_hoja2_import ss
join public.products p on p.sku = trim(ss.product_sku)
left join public.inventory_balances ib on ib.product_id = p.id
on conflict (product_id)
do update set
  stock_on_hand = excluded.stock_on_hand,
  updated_at = now();

update public.products p
set stock_on_hand = ib.stock_on_hand,
    avg_cost = ib.avg_cost,
    min_stock = ib.min_stock,
    updated_at = now()
from public.inventory_balances ib
where p.id = ib.product_id;

update public.products p
set unit = coalesce(nullif(trim(ss.unit), ''), p.unit),
    updated_at = now()
from public.stg_stock_actual_hoja2_import ss
where p.sku = trim(ss.product_sku);

commit;

-- -------------------------------------------------------------------
-- 6) Verificacion rapida de metricas pedidas
-- -------------------------------------------------------------------
select 'stock_actual_unidades' as metrica,
       round(coalesce(sum(ib.stock_on_hand), 0), 4) as valor
from public.inventory_balances ib

union all

select 'inversion_compras',
       round(coalesce(sum(p.total_cost), 0), 4)
from public.purchases p
where p.invoice_no in (
  'IMPORT-HOJA1-TANIA-YUCRA-001',
  'IMPORT-HOJA1-EMPRESA-AYRAMPO-001'
)

union all

select 'ventas_realizadas',
       round(coalesce(sum(s.total), 0), 4)
from public.sales s
where s.payment_method = 'IMPORT-HOJA2'

union all

select 'ganancia_final',
       round(
         coalesce((select sum(s.total) from public.sales s where s.payment_method = 'IMPORT-HOJA2'), 0)
         - coalesce((select sum(v.cost_total) from public.stg_ventas_hoja2_import v where coalesce(v.line_total, 0) > 0), 0),
         4
       );
