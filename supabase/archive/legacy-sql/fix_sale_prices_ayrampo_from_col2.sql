-- Corrige precios de venta retail para productos de la compra
-- IMPORT-HOJA1-EMPRESA-AYRAMPO-001
-- Fuente: columna 2 del Excel (precio_unidad_venta_2)
-- Archivo origen local: data/productos_excel_listado_completo.csv
--
-- Este script SOLO ajusta precios de venta (products + product_prices).
-- No modifica compras, costos ni stock.

begin;

create temporary table tmp_ayrampo_col2_prices (
  sku text primary key,
  sale_price numeric(12,4) not null check (sale_price >= 0)
) on commit drop;

insert into tmp_ayrampo_col2_prices (sku, sale_price)
values
  ('SKU-0202856B37', 12.0000),
  ('SKU-039AB24A72', 18.0000),
  ('SKU-04E6FF7B12', 3.5000),
  ('SKU-06298A559F', 6.0000),
  ('SKU-0868F564AF', 2.5000),
  ('SKU-096E7DB466', 3.5000),
  ('SKU-0B24D6F164', 4.0000),
  ('SKU-0C2AB09E16', 1.5000),
  ('SKU-0E6AA9F21D', 3.0000),
  ('SKU-0F68E2EC13', 1.0000),
  ('SKU-1046AB44A5', 6.0000),
  ('SKU-145EBEB2A3', 5.0000),
  ('SKU-14F63E966D', 0.2000),
  ('SKU-165935C822', 4.5000),
  ('SKU-1B4019FFD0', 2.0000),
  ('SKU-1C8518A3F6', 7.0000),
  ('SKU-1EDA4B9225', 5.0000),
  ('SKU-232269CDDF', 1.5000),
  ('SKU-24D54B3207', 8.0000),
  ('SKU-250A95296D', 2.0000),
  ('SKU-2544F733EC', 18.0000),
  ('SKU-25611AAAAD', 0.5000),
  ('SKU-2981C63A39', 5.0000),
  ('SKU-2BEED389E4', 2.5000),
  ('SKU-3023CF7487', 5.0000),
  ('SKU-308DF87D2B', 1.0000),
  ('SKU-34FB243C18', 0.1000),
  ('SKU-383B65F71F', 4.0000),
  ('SKU-384706C8BB', 0.8000),
  ('SKU-398C843E98', 12.0000),
  ('SKU-3AFD2E7935', 4.5000),
  ('SKU-3BE02203E7', 3.0000),
  ('SKU-418AE7AD5C', 1.5000),
  ('SKU-41BFC833EE', 1.5000),
  ('SKU-44763E1EDC', 5.0000),
  ('SKU-448A8AC612', 1.0000),
  ('SKU-44D2FC2D50', 1.0000),
  ('SKU-488624C093', 9.0000),
  ('SKU-4985AB403E', 0.7000),
  ('SKU-4D785AB75B', 8.0000),
  ('SKU-4EE3C50F1D', 1.0000),
  ('SKU-50A319EDA9', 1.0000),
  ('SKU-51D94161E4', 2.0000),
  ('SKU-53F12AE701', 5.0000),
  ('SKU-56432F1B7F', 10.0000),
  ('SKU-58B59695F9', 20.0000),
  ('SKU-5FE2F611DF', 9.0000),
  ('SKU-6381846E56', 15.0000),
  ('SKU-64AF411C73', 6.0000),
  ('SKU-64BDAEE8CD', 1.0000),
  ('SKU-6549630E71', 4.0000),
  ('SKU-65B092F11F', 3.5000),
  ('SKU-66529C0038', 1.0000),
  ('SKU-67CEA9B1B6', 3.5000),
  ('SKU-67EC263080', 6.0000),
  ('SKU-6A944058B9', 1.0000),
  ('SKU-6AD4414B14', 10.0000),
  ('SKU-6AFF87246E', 2.5000),
  ('SKU-6B0F82BDFF', 12.0000),
  ('SKU-6E4CFB4AB7', 0.5000),
  ('SKU-6F4B1E2A08', 1.5000),
  ('SKU-71703659EC', 7.0000),
  ('SKU-73ECB72794', 15.0000),
  ('SKU-74D37CB40E', 1.0000),
  ('SKU-7538FE51BC', 8.0000),
  ('SKU-7762F9C08A', 1.0000),
  ('SKU-77F19E15CF', 3.5000),
  ('SKU-78A62B9611', 0.5000),
  ('SKU-78B895FADB', 2.0000),
  ('SKU-7A82393C55', 1.0000),
  ('SKU-7CD255990C', 1.5000),
  ('SKU-7EEE248D9B', 0.5000),
  ('SKU-81B56FA010', 3.5000),
  ('SKU-83CD5D38B1', 1.0000),
  ('SKU-83F6CC885D', 3.0000),
  ('SKU-8601F96067', 3.5000),
  ('SKU-8697FBECCC', 17.0000),
  ('SKU-87FB5C45C1', 0.5000),
  ('SKU-8A83060E82', 5.0000),
  ('SKU-8BE215E80A', 6.0000),
  ('SKU-8C03C7B0A4', 1.0000),
  ('SKU-8D86A147F9', 6.0000),
  ('SKU-8D8B2631DB', 1.5000),
  ('SKU-8EC5F5CD1C', 4.0000),
  ('SKU-8FC03EDBA8', 3.5000),
  ('SKU-90944B7E8F', 2.0000),
  ('SKU-93E5BF3071', 1.5000),
  ('SKU-96A54B592D', 2.5000),
  ('SKU-96FF456458', 1.5000),
  ('SKU-980BA39232', 0.1000),
  ('SKU-9A059C1BC2', 7.0000),
  ('SKU-9D4E4EE716', 0.5000),
  ('SKU-9D9DA3D551', 0.5000),
  ('SKU-9DACA2AC67', 3.5000),
  ('SKU-9E86C13A28', 2.0000),
  ('SKU-9FB3EB5C65', 0.5000),
  ('SKU-9FCECC1704', 0.5000),
  ('SKU-9FD0B9F742', 3.5000),
  ('SKU-A292B4DE9C', 4.0000),
  ('SKU-A47A5E460A', 5.0000),
  ('SKU-A4C46F4DA5', 4.0000),
  ('SKU-A744CA3157', 2.5000),
  ('SKU-A8C9B88E81', 4.0000),
  ('SKU-AAD11162D5', 3.5000),
  ('SKU-ACD539DCF8', 3.5000),
  ('SKU-B0946D98AA', 3.0000),
  ('SKU-B1B6F52169', 4.0000),
  ('SKU-B1DE97BF6F', 2.0000),
  ('SKU-B2904A3F21', 1.5000),
  ('SKU-B298BDA13D', 10.0000),
  ('SKU-B2F5C02F79', 8.0000),
  ('SKU-B353E19BF7', 0.5000),
  ('SKU-B6B52CD788', 3.0000),
  ('SKU-B8814F277F', 2.0000),
  ('SKU-BA273CD9CC', 2.5000),
  ('SKU-BA9E6F373B', 2.0000),
  ('SKU-BF27740F3E', 4.0000),
  ('SKU-C031FE8F76', 5.0000),
  ('SKU-C34DBFF5C5', 2.0000),
  ('SKU-C74ADF4922', 0.1000),
  ('SKU-CB9437A81C', 8.0000),
  ('SKU-CC7C567DF1', 1.5000),
  ('SKU-CEFF1F2EA0', 2.0000),
  ('SKU-CF887E5EC4', 2.5000),
  ('SKU-CFBA4FF0E5', 3.5000),
  ('SKU-D35B231535', 6.0000),
  ('SKU-D726876DA1', 1.5000),
  ('SKU-D7B21404F3', 8.0000),
  ('SKU-D80DB7710E', 0.5000),
  ('SKU-D8947D85F1', 1.0000),
  ('SKU-D8FC9604BF', 5.0000),
  ('SKU-D9A535C356', 4.0000),
  ('SKU-DAADE270A8', 7.0000),
  ('SKU-DCB1B82D14', 2.0000),
  ('SKU-DDAC91E10D', 18.0000),
  ('SKU-DFB871122D', 7.0000),
  ('SKU-E082FFFBDB', 27.0000),
  ('SKU-E4B751776A', 0.2000),
  ('SKU-E784193A9C', 1.5000),
  ('SKU-E7A85984D4', 2.0000),
  ('SKU-E8640331AC', 8.0000),
  ('SKU-EC04730CBE', 2.0000),
  ('SKU-EE5659CFF7', 5.0000),
  ('SKU-F0552067DA', 8.0000),
  ('SKU-F06AE39D3D', 1.5000),
  ('SKU-F0F3D54703', 4.5000),
  ('SKU-F3BED90DF2', 2.0000),
  ('SKU-F7DA7DEB25', 2.5000),
  ('SKU-F80351F0F5', 3.5000),
  ('SKU-FA80AA5B55', 5.0000),
  ('SKU-FB6932B48B', 2.0000),
  ('SKU-FE809B4294', 4.0000),
  ('SKU-FEBDB0D6D3', 4.5000);

create temporary table tmp_target_products on commit drop as
select distinct
  pr.id as product_id,
  pr.sku
from public.purchases p
join public.purchase_items pi on pi.purchase_id = p.id
join public.products pr on pr.id = pi.product_id
where p.invoice_no = 'IMPORT-HOJA1-EMPRESA-AYRAMPO-001';

-- Validaciones de consistencia
DO $$
declare
  v_target_count int;
  v_price_count int;
  v_missing_count int;
begin
  select count(*) into v_target_count from tmp_target_products;
  select count(*) into v_price_count from tmp_ayrampo_col2_prices;

  select count(*) into v_missing_count
  from tmp_target_products t
  left join tmp_ayrampo_col2_prices p on p.sku = t.sku
  where p.sku is null;

  if v_missing_count > 0 then
    raise exception 'Faltan precios col2 para % SKU objetivo de Ayrampo', v_missing_count;
  end if;

  raise notice 'target_skus=%  loaded_prices=%', v_target_count, v_price_count;
end $$;

create temporary table tmp_changes on commit drop as
select
  t.product_id,
  t.sku,
  coalesce(curr.id, null) as current_price_id,
  coalesce(curr.sale_price, p.sale_price, 0)::numeric(12,4) as old_sale_price,
  src.sale_price::numeric(12,4) as new_sale_price
from tmp_target_products t
join public.products p on p.id = t.product_id
join tmp_ayrampo_col2_prices src on src.sku = t.sku
left join lateral (
  select pp.id, pp.sale_price
  from public.product_prices pp
  where pp.product_id = t.product_id
    and pp.price_list = 'retail'
    and pp.currency = 'PEN'
    and pp.is_current = true
  order by pp.valid_from desc, pp.created_at desc
  limit 1
) curr on true
where round(coalesce(curr.sale_price, p.sale_price, 0)::numeric, 4)
    <> round(src.sale_price::numeric, 4);

-- Cerrar precios retail actuales (solo en productos con cambio)
update public.product_prices pp
set is_current = false,
    valid_to = coalesce(pp.valid_to, now())
from tmp_changes c
where pp.id = c.current_price_id
  and pp.is_current = true;

-- Insertar nueva tarifa retail actual
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
  c.product_id,
  'retail',
  c.new_sale_price,
  c.new_sale_price,
  'PEN',
  now(),
  true,
  now()
from tmp_changes c;

-- Sincronizar campo legacy en products
update public.products p
set sale_price = c.new_sale_price,
    updated_at = now()
from tmp_changes c
where p.id = c.product_id;

-- Resumen
select
  count(*) as products_updated,
  min(new_sale_price) as min_new_price,
  max(new_sale_price) as max_new_price
from tmp_changes;

select
  c.sku,
  c.old_sale_price,
  c.new_sale_price
from tmp_changes c
order by c.sku
limit 50;

commit;
