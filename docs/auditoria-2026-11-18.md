# Auditoría de arquitectura — 2026-11-18

Revisión de solo lectura, sin cambios en el código. Cada hallazgo se verificó leyendo el código. No se ejecutó nada contra la base de datos, así que los impactos de rendimiento son estimaciones.

## Arquitectura en una línea

La app es Nuxt 3 en modo SPA (`ssr:false`) sobre Vercel. El backend son rutas Nitro (`server/api`) más módulos por dominio con capas `ports/app/infra` en `server/modules`, todo sobre Supabase. Los cálculos críticos (venta, precio) viven en RPC de Postgres y las cookies son httpOnly.

La base es correcta. Los problemas están en tres sitios:
- rutas que se saltan la autenticación;
- políticas RLS demasiado amplias;
- reportes y vistas que cargan todo en memoria.

---

## 1. Seguridad

### CRÍTICO

**S1. Rutas `/api/school/*` sin autenticación y con service-role**

- **Dónde:** `server/api/school/{lists,list-items,item-brands,institutions,grades,sections,all-lists-stock.get,stock-analysis.get,presentation-prices.get}.ts`.
- **Qué pasa:** ninguna verifica la sesión, y todas usan `getSupabaseAdminClient()`, que se salta RLS.
- **Riesgo:** cualquiera en Internet puede crear, editar o **borrar** listas escolares e ítems (DELETE en `list-items.ts:33` e `item-brands.ts:110`), y leer stock y precios.
- **Arreglo:** `await requireAccessToken(event)` (o `requireOwner` en las escrituras) al inicio. Usar el cliente de usuario en lugar del admin donde RLS lo permita.

**S2. `/api/webhook/send-message` es un relé abierto**

- **Dónde:** `server/api/webhook/send-message.post.ts`.
- **Riesgo:** sin autenticación, envía cualquier texto a cualquier número **desde la cuenta de WhatsApp Business**. Eso permite spam, suplantación de la tienda y bloqueo de la cuenta por Meta.
- **Archivo relacionado:** `whatsapp.post.ts:25` lo llama arma la URL con el header `Host` del request (inyección de host) y sin `await` (en serverless el mensaje puede perderse).
- **Arreglo:** convertirlo en una función interna (import directo) y borrar la ruta.

**S3. Escalada de privilegios a `owner`**

La cadena tiene tres pasos:
1. `/api/auth/sign-up` es público. `handle_new_user` (`baseline.sql:841`) asigna `cashier` a todo usuario nuevo.
2. La política `profiles_update_own` (`baseline.sql:4015`) permite al usuario hacer `UPDATE` de su propia fila **sin `WITH CHECK` ni restricción de columna**.
3. Con el JWT y la anon key, basta un `PATCH /rest/v1/profiles?id=eq.<uid>` con `{"role":"owner"}`.

- **Atenuante:** hoy la anon key no se envía al navegador, así que la defensa depende de que esa clave no se filtre. Supabase la considera pública por diseño.
- **Arreglo (las dos cosas):**
  - desactivar el registro público (borrar la ruta sign-up y poner `enable_signup=false` en el proyecto); los usuarios ya se crean desde `/api/admin/create-user`;
  - aplicar `REVOKE UPDATE (role) ON profiles FROM authenticated`, o un trigger que impida cambiar `role` si no es `is_owner()`.

### ALTO

**S4. Endpoints de solo-owner protegidos solo en el cliente**

- **Dónde:** las páginas usan `middleware: ['owner']`, pero sus APIs aceptan cualquier sesión. Afecta a `reports/financial-summary`, `product-profitability`, `executive-*`, `sales-restock` y `school-restock`, y también a `pricing/*` y `maintenance/*`; conviene revisar la lista completa.
- **Riesgo:** un cajero puede leer márgenes y costos llamando la API directamente.
- **Arreglo:** `requireOwner(event)` en esas rutas. El middleware de página es solo UX.

**S5. RLS `*_all_auth` en tablas contables**

- **Dónde:** `sales`, `sale_items`, `stock_movements`, `stock_cost_layers`, `sale_cost_allocations`, `purchases`, `products`, `inventory_*`, `customers` y `suppliers` tienen `USING (auth.uid() IS NOT NULL)` para ALL.
- **Riesgo:** cualquier usuario autenticado puede editar o borrar ventas, capas FIFO o stock directamente por REST, sin pasar por las RPC.
- **Arreglo:** para usuarios normales, solo SELECT. Las escrituras, solo vía RPC `SECURITY DEFINER`, que ya existen (`create_sale`, `create_purchase`…), o bien restringidas a `is_owner()`.

**S6. Tablas sin RLS y con `GRANT ALL` a `anon`**

- **Dónde:** `import_batches`, `stg_compras_ayrampo_import`, `stg_compras_tania_import` y `stg_productos_import`.
- **Arreglo:** borrarlas si ya no se usan o, si se usan, activar RLS.

**S7. Cachés de IA escribibles por cualquiera**

- **Dónde:** `image_cache` y `match_cache` tienen INSERT/UPDATE `USING (true)` sin rol (`baseline.sql:3768-3788`).
- **Riesgo:** envenenamiento de caché, es decir, respuestas falsas del matcher.
- **Arreglo:** limitarlas a `service_role`.

**S8. Webhook de WhatsApp sin firma**

- **Dónde:** `whatsapp.post.ts` no valida `X-Hub-Signature-256`. Cualquiera puede inyectar mensajes falsos que crean pedidos (`createSalesOrderFromWhatsApp`) y gastan OpenAI.
- **Relacionado:** `whatsapp.get.ts:10` tiene un verify token por defecto fijo en el código.
- **Arreglo:** validar la firma con HMAC usando el App Secret y quitar el valor por defecto.

**S9. `notify-order-ready` sin autenticación**

- **Riesgo:** lee pedidos con service-role y envía la imagen que se le pase al teléfono del cliente.
- **Arreglo:** exigir sesión.

**S10. `products/search` sin autenticación y con service-role**

- **Riesgo:** expone el catálogo con precios y stock.
- **Arreglo:** sesión + cliente de usuario.

### BIEN HECHO

- Auth del agente con `timingSafeEqual` (`utils/agent.ts:35`).
- `/vincular` con límites de intentos y JSON-only.
- Cookies httpOnly/SameSite.
- `create_sale` valida `auth.uid()` y el rol para descuentos.
- Guard que impide tocar la BD remota desde dev.
- Sin secretos en el repo.

### Correcciones posteriores (al detallar las fases, mismo día)

- **S4 era menor:** `pricing/*`, `maintenance/*` y `admin/*` ya usan `requireOwner`. Las APIs abiertas eran solo las de reportes. Ver `fases/fase-0-seguridad.md` F0-T6.
- **S11 (nuevo, ALTO):** `utiles/analyze-image` y `utiles/match` aceptan cualquier `x-webhook-token`, lo que permite gastar OpenAI sin sesión. Ver F0-T3.
- **S12 (nuevo, ALTO):**
  - compras, edición de productos (incluido stock y costo), aplicación de conteos y proveedores solo exigen sesión, sin validar rol, y sus funciones de BD tampoco lo validan;
  - `create_sales_order` acepta cualquier precio enviado por el cajero.

  Ver F0-T9.
- **La lectura de listas por foto (`utiles`) sí se usa.** `aiLogic.ts` no se borra entero en la Fase 0 (D49).

---

## 2. Rendimiento

### ALTO

**P1. La vista `product_catalog` es pesada y se usa en todas partes**

- **Dónde:** `baseline.sql:2326`. La vista hace varios `LEFT JOIN LATERAL` (FIFO, costo promedio, UOM) por producto.
- **Quién la usa:** POS, compras, precios, inventario y dashboard. Pedir pocas columnas no ahorra nada.
- **Arreglo:** una vista liviana `product_catalog_lite` para esas pantallas. Dejar la completa solo para productos y reportes.

**P2. El tope de 1000 filas trunca datos sin avisar**

Supabase devuelve como máximo 1000 filas por consulta (`max_rows`).
- `supabaseDashboardRepository.ts:12` trae todas las ventas y compras para sumarlas en JS: **con más de 1000 ventas, los totales del dashboard salen mal**.
- Lo mismo pasa con los catálogos sin paginar en sales, products, purchases, pricing, inventory y school-restock.
- **Arreglo:** sumas en SQL (RPC) y el `fetchAll` paginado que ya existe en `supabaseReportsRepository.ts:320`.

**P3. Reportes que bajan tablas completas**

- `getExecutiveInvestmentReport.ts:394` baja **todo el historial** de `sale_items` solo para sacar la última venta por producto.
- `fetchAll` pagina en serie.
- **Arreglo:** `select product_id, max(sale_date) … group by` en una RPC, y mover las agregaciones a SQL.

**P4. Índices faltantes**

- **Fechas:** `sales.sale_date`, `sales.created_at`, `purchases.purchase_date`, `stock_movements(movement_type, created_at)`.
- **Claves foráneas:** `school_list_items.list_id` y `school_list_item_brands(item_id, product_id)`.
- **Búsqueda de texto:** trigram en `products.name` y `customers.name` (hoy hay `ilike '%x%'` sin índice).

### MEDIO

**P5. Bucles con `await` en serie**

- `catalogAnswers.ts:43`: hasta 50 RPC.
- `prepareSale.ts:143`: un embedding de OpenAI por línea.
- `supabasePurchasesRepository.ts:154` y `productSearchIndexer.ts:22`.
- **Arreglo:** `Promise.all` o un lote.

**P6. Repreciado del carrito en el POS**

- **Dónde:** `pages/sales.vue:1034`. Se hace un HTTP por ítem, en serie, al cambiar de cliente: unos 15 ítems tardan cerca de 3 s.
- **Arreglo:** un endpoint que reciba el lote.

**P7. Escrituras sin `await` en serverless**

- **Dónde:** `aiLogic.ts:138` y `:339`.
- **Riesgo:** Vercel congela la función y la caché nunca se guarda, así que se paga OpenAI otra vez.

### BAJO

- **`xlsx` estático:** `products.vue:2` lo importa siempre (unos 400 KB). Mejor `await import('xlsx')`.
- **Búsqueda del POS:** recalcula y normaliza todo el catálogo en cada tecla (`sales.vue:1814`). Conviene un debounce y normalizar el texto una sola vez.

---

## 3. Buenas prácticas y simplicidad

### ALTO

**C1. La capa `app/` es ceremonia**

- 41 archivos de 4 a 10 líneas solo reenvían al repo (ej. `sales/app/createSale.ts`).
- Cada port tiene una sola implementación y varios ports son `Record<string, any>`.
- La regla no se cumple de forma pareja: 34 rutas no usan módulos, y `getExecutiveInvestmentReport.ts` está en `app/` pero consulta Supabase y define colores de UI.
- **Recomendación:** quitar `app/` donde solo reenvía y dejar `ports/app` solo en `agent`, que sí tiene lógica y tests.

**C2. Dos sistemas de IA en paralelo**

- `server/utils/aiLogic.ts` (600 líneas, flujo WhatsApp) duplica lo que `modules/agent` hace mejor:
  - modelos fijos en el código;
  - limpieza de JSON con regex en vez de `zodResponseFormat`;
  - un segundo índice de embeddings (`match_products` frente a `search_products_hybrid`).
- Tiene reglas de idioma fijas, lo que contradice el principio «IA interpreta, código verifica». Ejemplo: `text.includes('no')` también es verdadero con «sino» o «nota» (`schoolList.ts:270`, `whatsapp.post.ts:406`).
- **Recomendación:** si WhatsApp no está en producción, borrar todo ese flujo (webhook, send-message, aiLogic, whatsappFormatter/Media, transcribeAudio, utiles/modify-cart, utiles/embed-catalog). Si está vivo, que use `modules/agent`.

**C3. Código muerto verificado**

- **Endpoints que nada llama:** `webhook/send-message` (salvo el webhook), `utiles/modify-cart`, `utiles/embed-catalog` y `reports/executive-profitability` (reemplazado por `executive-investment`), con su `getExecutiveProfitability.ts` y parte del repo de reportes.
- **Componentes:** los 4 `components/reports/Executive*.vue` no se usan en ninguna página. Hay cambios sin commitear en ellos: confirmar si es trabajo en curso.

**C4. Modo legacy del agente sigue como default**

- `posAgentSelector: 'legacy'` mantiene dos caminos completos.
- **Recomendación:** cuando el benchmark de `llm` sea definitivo, cambiar el default y borrar legacy: `draftBuilder`, `openaiOrderInterpreter`, `openaiProductSelector`, `contextSelection` y `prepareSale`, según lo que use cada camino.

**C5. Precios de listas escolares paralelos al POS**

- **Dónde:** `utils/schoolPricing.ts` y `school/presentation-prices.get.ts` reimplementan reglas de precio sin mayoreo, promociones ni grupo de cliente.
- **Riesgo:** **la cotización puede no coincidir con lo que se cobra.**
- **Recomendación:** usar la RPC `resolve_sale_item_pricing`. La elección de marca está repetida en 3 archivos.

### MEDIO

**C6. Helpers duplicados**

- `toNumber` existe en 10 archivos del servidor; `formatMoney` en 10 páginas, con dos formatos distintos.
- El bloque catch→500 se repite 51 veces.
- **Recomendación:** `utils/format.ts` (Nuxt lo auto-importa) y `server/utils/num.ts`.

**C7. Páginas gigantes**

- `sales.vue` (3461 líneas) tiene 4 pestañas en un archivo: extraerlas como ya se hizo con `PosTicketPanel`.
- Ventas en espera con modo dual BD/localStorage, detectado por el texto del error (`sales.vue:268`): borrar el modo local.
- `executive-profitability.vue` tiene 60 `computed`.

**C8. Validación de entrada**

- Hay 53 rutas con `readBody` y solo 2 validan con zod.
- **Recomendación:** `readValidatedBody(event, schema.parse)` en las rutas que escriben.

**C9. `transcribeAudio.ts`**

- Crea un cliente OpenAI que no usa y lee `process.env` directamente.
- **Recomendación:** usar `openai.audio.transcriptions.create` y quitar `form-data` y `@types/form-data` de las dependencias.

### BAJO

- **TypeScript:** hay `(event.context as any)` 12 veces en `utils/auth.ts`. Se resuelve con un `declare module 'h3'`.
- **Archivos versionados sin uso:** `result.json`, `data/*.csv`, `supabase/archive/` y `scripts/repair-uom-fifo.mjs` (de un solo uso).
- **`nuxt.config.ts`:**
  - el host de ngrok está fijo en el código;
  - `0.0.0.0` duplica `--host`;
  - un comentario quedó fuera de lugar en la línea 36.
- **Tests:** solo cubren el agente. Lo mínimo útil sería un test de precio escolar al unificarlo.

### Lo que está bien hecho

- Precio y venta resueltos en la BD con RPC: una sola fuente de verdad.
- `modules/agent` con salidas zod estructuradas, contratos y 5 suites de tests.
- `runtimeModes.ts` falla hacia el lado seguro (dry-run gana).
- Handlers delgados.
- La extracción de componentes ya funciona en stock-ai y el ticket del POS.

---

## Orden recomendado

1. **Hoy:** S1, S2, S3 (auth en school/*, cerrar send-message, desactivar sign-up y bloquear el cambio de `role`).
2. **Esta semana:**
   - S4 (`requireOwner` en reportes, precios y mantenimiento);
   - S5–S7 (endurecer RLS en una migración);
   - S8 y S9.
3. **Rendimiento:** P4 (índices), P2 (dashboard en SQL), P1 (vista liviana), P3.
4. **Limpieza:** decidir el destino de WhatsApp (C2), el default del agente (C4) y borrar el código muerto (C3). El resto, de forma incremental.
