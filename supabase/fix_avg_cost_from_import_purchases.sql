begin;

-- Corrige avg_cost visible en frontend para productos afectados por importaciones.
-- Por defecto incluye Ayrampo; agrega Tania si quieres recalcular ambos.
with target_invoices(invoice_no) as (
  values
    ('IMPORT-HOJA1-EMPRESA-AYRAMPO-001'),('IMPORT-HOJA1-TANIA-YUCRA-001')
),
affected_products as (
  select distinct pi.product_id
  from public.purchase_items pi
  join public.purchases p on p.id = pi.purchase_id
  join target_invoices t on t.invoice_no = p.invoice_no
  where coalesce(pi.qty, 0) > 0
),
historical_purchase_totals as (
  select
    pi.product_id,
    sum(coalesce(pi.qty, 0))::numeric(14,4) as total_qty,
    sum(coalesce(pi.total_cost, 0))::numeric(14,4) as total_cost
  from public.purchase_items pi
  join affected_products ap on ap.product_id = pi.product_id
  where coalesce(pi.qty, 0) > 0
  group by pi.product_id
),
new_avg as (
  select
    hpt.product_id,
    case
      when hpt.total_qty <= 0 then 0::numeric(12,4)
      else round((hpt.total_cost / hpt.total_qty)::numeric, 4)
    end as avg_cost
  from historical_purchase_totals hpt
),
ensure_balance as (
  insert into public.inventory_balances (product_id, stock_on_hand, avg_cost, min_stock, updated_at)
  select
    p.id,
    coalesce(p.stock_on_hand, 0),
    0,
    coalesce(p.min_stock, 0),
    now()
  from public.products p
  join new_avg na on na.product_id = p.id
  on conflict (product_id) do nothing
  returning product_id
),
updated_balances as (
  update public.inventory_balances ib
  set avg_cost = na.avg_cost,
      updated_at = now()
  from new_avg na
  where ib.product_id = na.product_id
  returning ib.product_id, ib.avg_cost
)
update public.products p
set avg_cost = ub.avg_cost,
    updated_at = now()
from updated_balances ub
where p.id = ub.product_id;

commit;

-- Verificacion rapida
with target_invoices(invoice_no) as (
  values
    ('IMPORT-HOJA1-EMPRESA-AYRAMPO-001') ,('IMPORT-HOJA1-TANIA-YUCRA-001')
),
affected_products as (
  select distinct pi.product_id
  from public.purchase_items pi
  join public.purchases p on p.id = pi.purchase_id
  join target_invoices t on t.invoice_no = p.invoice_no
),
check_rows as (
  select
    p.sku,
    p.name,
    p.avg_cost as products_avg_cost,
    ib.avg_cost as inventory_avg_cost
  from affected_products ap
  join public.products p on p.id = ap.product_id
  left join public.inventory_balances ib on ib.product_id = ap.product_id
)
select *
from check_rows
order by name
limit 50;
