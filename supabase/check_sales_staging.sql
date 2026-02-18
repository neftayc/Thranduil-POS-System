-- Verificar la estructura de los datos staging de ventas
-- para entender si realmente hay ventas con múltiples productos

-- 1. Ver muestra de datos staging
SELECT 
  sale_ref,
  product_sku,
  product_name,
  qty,
  line_total
FROM public.stg_ventas_hoja2_import
ORDER BY sale_ref, product_sku
LIMIT 20;

-- 2. Contar productos por sale_ref
SELECT 
  sale_ref,
  COUNT(*) as num_productos,
  SUM(line_total) as total_venta
FROM public.stg_ventas_hoja2_import
WHERE coalesce(qty, 0) > 0
  AND coalesce(line_total, 0) > 0
GROUP BY sale_ref
ORDER BY num_productos DESC
LIMIT 20;

-- 3. Ver distribución de productos por venta
SELECT 
  num_productos,
  COUNT(*) as cantidad_ventas
FROM (
  SELECT 
    sale_ref,
    COUNT(*) as num_productos
  FROM public.stg_ventas_hoja2_import
  WHERE coalesce(qty, 0) > 0
    AND coalesce(line_total, 0) > 0
  GROUP BY sale_ref
) sub
GROUP BY num_productos
ORDER BY num_productos;

-- 4. Verificar estado actual de la tabla sales
SELECT 
  s.id,
  s.sale_date,
  s.total,
  COUNT(si.id) as num_items,
  s.payment_method
FROM public.sales s
LEFT JOIN public.sale_items si ON si.sale_id = s.id
WHERE s.payment_method = 'IMPORT-HOJA2'
GROUP BY s.id, s.sale_date, s.total, s.payment_method
ORDER BY s.sale_date DESC
LIMIT 20;
