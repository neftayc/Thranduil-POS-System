alter table public.supplier_quote_items
  add column if not exists product_snapshot_brand text;

update public.supplier_quote_items qi
set product_snapshot_brand = pc.brand
from public.product_catalog pc
where qi.product_id = pc.id
  and qi.product_snapshot_brand is null;
