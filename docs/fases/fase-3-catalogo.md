# Fase 3 — Catálogo

> **Estado:** Por validar al iniciar · **Detalle:** por caso de uso + modelo de dominio
> **Arquitectura:** [`../arquitectura.md`](../arquitectura.md) — D2, D3, D35, D36, D37, D38; §5.1 (contexto `catalog`), §5.2, §6, §8.2, §18.1.
> Las referencias `archivo:línea` son del 2026-11-18 y se revalidan en F3-T1.

---

## 1. Objetivo y alcance

Crear el contexto **`catalog`** como hexagonal y llevar al dominio TypeScript las reglas de producto, unidades, conversiones y categorías que hoy viven en PL/pgSQL. Es la primera fase de dominio: además valida el patrón completo (dominio → caso de uso → puerto → adaptador Drizzle → ruta HTTP → interruptor → tests de caracterización), que reutilizan las Fases 4 a 6.

**Entra:**
- Casos de uso `saveProduct`, `replaceConversions`, `getConversions`, `convertUnit` (consulta) y `ensureCategory` (interno).
- Resolución de unidades (`resolveUnitCode`) y normalización de categorías en el dominio.
- Generación de SKU automático en el dominio (hoy en `supabaseProductsRepository.ts:10-52`).
- Columnas nuevas `products.item_kind` y `products.attributes` (§5.2).
- Reemplazo de `upsert_product_catalog` y `replace_product_unit_conversions`, y retiro de los triggers guardianes de unidad y categoría.

**No entra:**
- **Stock y costo.** `saveProduct` deja de ser dueño del stock (D20). El comportamiento actual se conserva con un puerto temporal (§3.6, F3-T6) hasta la Fase 5.
- **Precio base y reglas de precio:** pasan a `pricing` en la Fase 4. En esta fase el precio base se sigue escribiendo como hoy, a través de un puerto temporal.
- **Lectura del catálogo** (`/api/products/page`, vista `product_catalog`): es lado de lectura, Fase 7.
- **Búsqueda** (`/api/products/search`, `search_products_hybrid`, índice de búsqueda): se queda en SQL (§9).
- **Composición de kits:** la define el módulo `kits` (Fase 8). Aquí solo se reserva el valor `kit` en `item_kind`.

---

## 2. Requisitos previos

- Fase 1 terminada: `layers/core/server/contexts/`, `UnitOfWork`, Drizzle con `app_backend`, `defineApiHandler`, Vitest con Supabase local y `seed.sql`, tipos `Money`/`Quantity`.
- Fase 2 terminada: `tenant_id` en `products`, `product_categories`, `uom_catalog` y `product_unit_conversions`; `UNIQUE (tenant_id, sku)`; RLS por negocio.
- **Decidido en la Fase 2:** cómo siguen funcionando las RPC antiguas (que exigen `auth.uid()`) cuando el backend usa conexión directa. Ver riesgo R1.
- Permiso `products.edit` disponible en `defineApiHandler` (D45: dueño y encargado).

---

## 3. Modelo de dominio

### 3.0 Comportamiento actual (referencia para la caracterización)

**`upsert_product_catalog`** (`baseline.sql:1832`). Llamada desde `supabaseProductsRepository.ts:244-279`:

1. Exige `auth.uid()` y nombre no vacío.
2. Moneda: `upper(p_currency)`, por defecto `PEN`.
3. Unidad base: `require_uom_code(p_unit)`, por defecto `unidad`.
4. Categoría: si viene `p_product_type` (nombre), `ensure_product_category(nombre)`. `product_type` queda con el nombre canónico de la categoría.
5. Si `p_id` es nulo **y el SKU existe**, **actualiza ese producto** (upsert por SKU). Si no existe, inserta.
6. Al actualizar:
   - `category_id = coalesce(nuevo, anterior)`: **no se puede quitar la categoría** enviando nulo;
   - `brand` y `barcode` vacíos pasan a `NULL`;
   - `active` nulo pasa a `true`;
   - `sale_price` nulo pasa a **0**;
   - `min_stock` nulo pasa a 0.
7. `inventory_balances`: crea la fila si falta; luego **sobrescribe `stock_on_hand` y `avg_cost` si vienen no nulos, sin registrar movimiento de stock ni lote FIFO**.
8. Precio: si no hay precio `retail` vigente, inserta uno. Si cambió, cierra el vigente (`is_current=false`, `valid_to=now()`) e inserta otro. Si no cambió, no hace nada.
9. Copia `sale_price`, `stock_on_hand`, `avg_cost` y `min_stock` también en `products` (doble fuente: D20 y Fase 4).

**SKU automático** (TS, solo al crear sin SKU):
- formato `SKU-<BASE>-<8 hex>`;
- `BASE` = nombre en mayúsculas, sin tildes ni caracteres no alfanuméricos, máximo 8 caracteres, o `ITEM` si queda vacío;
- hasta 30 intentos consultando la vista pesada; al final, sufijo con timestamp.

Todo SKU recibido se guarda `trim` + mayúsculas.

**Unidades:**
- `normalize_uom_code(x)` = `lower(trim(x))` (`:915`).
- `resolve_uom_code` (`:1650`) busca en `uom_catalog` **activo** coincidencias con `code`, `label`, `label+'s'` o `code+'s'`. Así, `cajas` → `caja`, pero **`unidades` no resuelve** (`unidad`+`s` = `unidads`).
- `require_uom_code` (`:1366`) lanza `Unidad "%" no existe en catálogo`.

**Conversiones:**
- **`replace_product_unit_conversions`** (`:1290`): borra todas las conversiones del producto y reinserta. Omite los ítems con nombre vacío y los que son la unidad base. Exige `factor > 0`; si no, lanza `Factor inválido para unidad "%"` y revierte todo. Si `p_items` no es arreglo, deja el producto sin conversiones y devuelve 0.
- Índice único `(product_id, lower(unit_name))`: un nombre repetido da error de unicidad.
- `factor_to_base numeric(12,6)`.

**`resolve_product_uom_factor`** (`:1417`):
- unidad vacía o igual a la base → 1;
- si no, busca una conversión **activa** del producto;
- si no hay, lanza `Unidad "%" no configurada para este producto`.

**Categorías:**
- `ensure_product_category` (`:768`):
  1. busca por nombre normalizado (`lower(trim)`; los espacios internos cuentan);
  2. si no, por `code`;
  3. si no, inserta con `sort_order = max + 10`.
- `normalize_category_code` (`:900`): minúsculas, espacios → `_`, quita lo no alfanumérico y los `_` de los bordes. Si queda vacío, el código es `cat_<12 hex>`.

**Triggers guardianes:**
- `trg_products_unit_guard` (`:1146`): normaliza `products.unit` al insertar o cambiar la unidad.
- `trg_products_category_guard` (`:1096`): sincroniza `category_id` ↔ `product_type`; error `Categoria inválida` si el id no existe.

**Quién más usa las funciones de unidades.** Por eso **no se borran en esta fase**:
- `create_purchase` (`:127-133`)
- `create_sale` (`:350-354`)
- `create_sales_order` / `pay_sales_order` (`:662-669`)
- trigger `purchase_items_sync_base_fields` (`:1185-1189`)
- `resolve_sale_item_pricing` (`:1503-1510`)
- vista `product_catalog` (`:2364-2451`)
- `resolve_payment_method_code` (usa `normalize_uom_code`)

### 3.1 Entidades y objetos de valor

| Elemento | Tipo | Contenido |
|---|---|---|
| `Product` | Agregado | `id`, `tenantId`, `sku: Sku`, `name`, `brand?`, `barcode?`, `description?`, `itemKind: ItemKind`, `baseUnit: UnitCode`, `categoryId?`, `attributes: Record<string, unknown>`, `minStock: Quantity` (provisional, ver §3.5), `active`, `conversions: UnitConversion[]` |
| `ItemKind` | Valor | `stock_item` (bien inventariable) · `service` (sin stock) · `kit` (reservado; composición en el módulo `kits`) |
| `Sku` | Valor | Texto `trim` + mayúsculas, no vacío. `Sku.generate(name, random)` reproduce el formato actual |
| `UnitCode` | Valor | Código canónico del catálogo de unidades del negocio |
| `UnitCatalog` | Valor (instantánea por negocio) | Lista de `{code, label, active}`. `resolve(text) → UnitCode \| null` con las reglas de §3.0 |
| `UnitConversion` | Entidad interna de `Product` | `unit: UnitCode`, `factorToBase: Decimal` (6 decimales), `active` |
| `Category` | Agregado pequeño | `id`, `code`, `name`, `active`, `sortOrder`. `Category.codeFrom(name)` = regla de `normalize_category_code` |

### 3.2 Invariantes

1. `name` no vacío tras `trim`.
2. `sku` único por negocio (lo garantiza el índice `UNIQUE (tenant_id, sku)`; el dominio reintenta la generación automática ante un choque).
3. `baseUnit` existe y está activa en el `UnitCatalog` del negocio.
4. Cada `UnitConversion`:
   - su unidad existe en el catálogo;
   - es distinta de `baseUnit`;
   - tiene `factorToBase > 0`;
   - no se repite dentro del producto.
5. `itemKind = service` no admite stock. El contexto `inventory` lo rechaza (Fase 5); aquí solo se guarda.
6. `attributes` cumple los esquemas zod de los módulos activos del negocio (§8.2). En esta fase no hay módulos: el registro devuelve un esquema vacío y `attributes` debe ser `{}`.
7. Cambiar `baseUnit` de un producto con conversiones **no las recalcula**, como hoy. Ver «Mejoras propuestas».

### 3.3 Eventos

| Evento | Cuándo | Consumidores previstos |
|---|---|---|
| `ProductCreated` | Alta | Módulos (Fase 8), agente (índice de búsqueda si se mueve) |
| `ProductUpdated` | Cambio de datos (incluye la lista de campos cambiados) | Ídem |
| `ProductConversionsReplaced` | Reemplazo de conversiones | Inventario y precios (invalidación de cachés) |

Se escriben en `outbox_events` dentro de la misma transacción (§8.3). El índice de búsqueda **no** depende de estos eventos: lo siguen manteniendo los triggers SQL (§3.7).

### 3.4 Casos de uso

| Caso de uso | Reemplaza | Notas |
|---|---|---|
| `saveProduct(input)` | `upsert_product_catalog` + SKU automático en TS | Alta y edición en una transacción. Conserva el upsert por SKU cuando no viene `id` (comportamiento actual). Precio base y stock, por puertos temporales (§3.6) |
| `replaceConversions(productId, items)` | `replace_product_unit_conversions` | Mismas reglas de omisión y error; transaccional |
| `getConversions(productId)` | Lectura en `supabaseProductsRepository.ts:297-311` | Consulta simple |
| `convertUnit(productId, unitText)` → `{unit, factor}` | `resolve_product_uom_factor` (para el código TS) | API pública para `pricing`, `purchasing` e `inventory`. La función SQL sigue viva para las RPC antiguas |
| `resolveUnitCode(text)` | `resolve_uom_code` / `require_uom_code` (para el código TS) | Función pura sobre `UnitCatalog` |
| `ensureCategory(name)` (interno) | `ensure_product_category` + trigger de categoría | Lo usa `saveProduct` |
| `findSimilarProducts(name, brand?)` | Lectura de `verify-brand.post.ts` | Consulta de lectura del contexto; sin reglas |

### 3.5 Decisiones de esta fase (por confirmar en F3-T1)

- **`min_stock`** sigue en `Product` por ahora. Con ubicaciones (D7) debería ser **por ubicación** y pasar a `inventory` en la Fase 5.
- **`product_type`** queda como columna heredada: el dominio la escribe igual al nombre de la categoría, para que el índice de búsqueda y la vista sigan iguales. Se elimina en la Fase 7.
- **Permiso:** hoy cualquier sesión puede crear o editar productos. Con D45, solo `products.edit` (dueño y encargado). Es un cambio de comportamiento aprobado por la matriz; se comunica a los cajeros.

### 3.6 Puertos temporales (se eliminan en fases posteriores)

| Puerto | Hace hoy | Se reemplaza en |
|---|---|---|
| `LegacyBasePricePort` | Historial `retail` en `product_prices` + copia en `products.sale_price` (pasos 8 y 9 de §3.0) | Fase 4 → `pricing.setBasePrice` |
| `LegacyStockOverridePort` | Si vienen `stock_on_hand`/`avg_cost`, sobrescribe `inventory_balances` y `products` **sin movimiento** (paso 7) | Fase 5 → stock inicial y ajustes como movimientos (`applyCount`, D20, D41) |

Los dos se implementan en `infrastructure/legacy/` con un comentario `// TEMPORAL: se elimina en Fase N` y un test que falla si siguen existiendo al cerrar esa fase.

### 3.7 Lo que sigue en la base de datos

- **Triggers de búsqueda:** `trg_products_search_index` (insert/update de `name`, `brand`, `product_type`, `category_id`, `active`), `trg_categories_search_index` (renombrar categoría), `trg_synonyms_search_index`. Siguen funcionando sin cambios; un test lo verifica (C14).
- **Restricciones:** `UNIQUE (tenant_id, sku)`, `uq_product_unit_conversions_product_unit`, `CHECK factor_to_base > 0`, `products_category_id_fkey`.
- **Funciones de unidades** (`normalize_uom_code`, `resolve_uom_code`, `require_uom_code`, `resolve_product_uom_factor`): se mantienen hasta que la última RPC que las usa desaparezca (Fase 6), y la vista hasta la Fase 7.

---

## 4. Tareas

### F3-T1 — Validación de inicio de fase
- **Objetivo:** aplicar la regla de `fases/README.md`.
- **Pasos:**
  1. Revisar el registro de cambios de las Fases 1 y 2.
  2. Revalidar las líneas citadas en §3.0.
  3. Confirmar las decisiones de §3.5.
  4. Confirmar la solución de R1.
- **Terminado cuando:** el estado de la fase es «Validada» y el registro de cambios está anotado.

### F3-T2 — Migración: `item_kind` y `attributes`
- **Archivos:** `supabase/migrations/<fecha>_catalog_item_kind_attributes.sql`, regenerar el esquema Drizzle (`drizzle-kit pull`, D37).
- **Pasos:**
  1. `ALTER TABLE products ADD COLUMN item_kind text NOT NULL DEFAULT 'stock_item' CHECK (item_kind IN ('stock_item','service','kit'))`.
  2. `ADD COLUMN attributes jsonb NOT NULL DEFAULT '{}'`.
  3. Sin cambios de datos (todo producto actual es `stock_item`).
- **Terminado cuando:** las migraciones aplican limpias en CI, el esquema Drizzle está actualizado y `pnpm db:backup` se hizo antes de producción.

### F3-T3 — Datos de prueba del catálogo
- **Archivos:** `supabase/seed.sql`.
- **Pasos:** agregar al negocio de prueba:
  - unidades `unidad/Unidad`, `caja/Caja`, `paquete/Paquete`, `docena/Docena`, `metro/Metro` (y una inactiva, `rollo`);
  - categorías `Útiles Escolares`, `Oficina`;
  - productos con y sin conversiones;
  - un producto con `product_prices` vigente distinto de `products.sale_price`.
- **Terminado cuando:** `supabase db reset` carga el seed y los tests de F3-T4 lo usan.

### F3-T4 — Tests de caracterización (contra el motor actual)
- **Archivos:** `tests/characterization/catalog/*.test.ts`.
- **Pasos:** escribir y poner en verde, con `ENGINE_CATALOG=db`, estos casos:

| # | Caso | Resultado esperado |
|---|---|---|
| C1 | Alta solo con nombre | Unidad `unidad`, `active=true`, precio 0, `min_stock` 0; fila en `inventory_balances` (0/0); precio `retail` vigente en 0 |
| C2 | Alta sin SKU | SKU con formato `^SKU-[A-Z0-9]{1,8}-[A-Z0-9]{1,8}$`; «Cuaderno A4 100h» → base `CUADERNO` |
| C3 | SKU `" ab-1 "` | Guardado `AB-1` |
| C4 | Sin `id` y SKU existente | Actualiza ese producto; no crea otro |
| C5 | Unidad `UNIDAD` / `cajas` / `Paquetes` / `''` / `unidades` / `xyz` / `rollo` (inactiva) | `unidad` / `caja` / `paquete` / `unidad` / error / error / error |
| C6 | Categoría nueva `Útiles Escolares` | Se crea con `sort_order = max+10`; `product_type` = nombre |
| C7 | Categoría `" útiles escolares "` | Reutiliza la existente |
| C8 | Edición con categoría nula | Mantiene la categoría anterior |
| C9 | Edición con precio distinto / igual | Cierra el vigente y crea otro / no hace nada |
| C10 | Edición con `stock_on_hand` y `avg_cost` | Sobrescribe `inventory_balances` y `products`; **no** crea `stock_movements` |
| C11 | Edición con stock nulo | Stock sin cambios |
| C12 | `brand` y `barcode` vacíos | `NULL` |
| C13 | Nombre `'   '` | Error 400 «Nombre obligatorio» |
| C14 | Alta y renombrado | `product_search_index` refleja el nombre nuevo |
| V1 | Conversiones `[{caja, 12}]` | 1 fila, unidad `caja` |
| V2 | Incluye la unidad base | Se omite |
| V3 | Nombre vacío | Se omite |
| V4 | Factor 0 / negativo / vacío | Error `Factor inválido…`; **las conversiones anteriores quedan intactas** |
| V5 | `caja` y `Cajas` juntas | Error de unicidad |
| V6 | `p_items` no es arreglo | Deja 0 conversiones |
| V7 | Unidad inexistente | Error `Unidad "…" no existe en catálogo` |
| V8 | `is_active=false` | Se guarda inactiva |
| U1 | Factor de unidad vacía o base | 1 |
| U2 | Factor de `caja` configurada | 12 |
| U3 | Factor de una conversión inactiva | Error `no configurada` |
| U4 | Factor de `docena` sin configurar | Error `no configurada` |

- **Terminado cuando:** todos pasan con `ENGINE_CATALOG=db` en CI.

### F3-T5 — Dominio
- **Archivos:** `layers/core/server/contexts/catalog/domain/{Product.ts, Sku.ts, UnitCatalog.ts, UnitConversion.ts, Category.ts, errors.ts}` + `*.test.ts`.
- **Pasos:**
  1. Implementar §3.1 y §3.2.
  2. Errores de dominio con código y mensaje en español (los mensajes de §3.0 se conservan textualmente).
  3. Tests unitarios de cada invariante y de `UnitCatalog.resolve` y `Category.codeFrom` con los mismos ejemplos de C5–C7.
- **Terminado cuando:** dominio sin imports externos (lo verifica `dependency-cruiser`) y cobertura de ramas del dominio ≥ 90 %.

### F3-T6 — Aplicación y puertos
- **Archivos:** `contexts/catalog/application/{ports.ts, saveProduct.ts, replaceConversions.ts, getConversions.ts, convertUnit.ts, findSimilarProducts.ts}`, `contexts/catalog/index.ts`.
- **Puertos:** `ProductRepository`, `UnitCatalogRepository`, `CategoryRepository`, `AttributeSchemaRegistry`, `LegacyBasePricePort`, `LegacyStockOverridePort`, `EventPublisher`, `UnitOfWork`, `TenantContext`, `Clock`.
- **Pasos:**
  1. Cada caso de uso corre dentro de `UnitOfWork`.
  2. `saveProduct` ejecuta, en orden: generar el SKU, cargar el catálogo de unidades, `ensureCategory`, guardar, llamar a los puertos temporales y publicar el evento.
  3. `index.ts` exporta solo `saveProduct`, `replaceConversions`, `getConversions`, `convertUnit`, `resolveUnitCode`, `findSimilarProducts`.
- **Terminado cuando:** hay tests de aplicación con repositorios en memoria para el flujo feliz y los errores.

### F3-T7 — Infraestructura
- **Archivos:** `contexts/catalog/infrastructure/{drizzleProductRepository.ts, drizzleUnitCatalogRepository.ts, drizzleCategoryRepository.ts, legacy/legacyBasePrice.ts, legacy/legacyStockOverride.ts}`.
- **Pasos:**
  1. Consultas sobre **tablas**, nunca sobre la vista `product_catalog`. Esto corrige también el `ensureAutoSku` caro de la auditoría (P11).
  2. Ante un choque de SKU automático (violación de unicidad), reintentar hasta 5 veces.
  3. `replaceConversions`: `DELETE` + `INSERT` en la misma transacción.
- **Terminado cuando:** hay tests de integración contra Supabase local en verde.

### F3-T8 — Adaptadores HTTP con interruptor
- **Archivos:**
  - `layers/core/server/api/products/catalog-upsert.post.ts`
  - `layers/core/server/api/products/conversions-replace.post.ts`
  - `layers/core/server/api/products/[id]/conversions.get.ts`
  - `layers/core/server/api/products/verify-brand.post.ts`
  - esquemas en `shared/schemas/catalog.ts`
- **Pasos:**
  1. Conservar las URL y la forma del payload (`p_*`) para no tocar `pages/products.vue:236-262` ni `components/stock-ai/QuotesView.vue:454-472` hasta la Fase 9.
  2. `defineApiHandler({ permission: 'products.edit', body: schema })`.
  3. Según `ENGINE_CATALOG`, llamar al caso de uso (`domain`) o a la RPC (`db`).
- **Terminado cuando:** los tests de F3-T4 pasan **con los dos motores**.

### F3-T9 — Activación gradual
- **Pasos:**
  1. `ENGINE_CATALOG=domain` en staging, con prueba manual de alta, edición, importación Excel y conversiones.
  2. Luego en producción. Observar Sentry durante **2 semanas**.
- **Terminado cuando:** pasaron 2 semanas sin errores atribuibles en producción.

### F3-T10 — Limpieza
- **Pasos:**
  1. Migración que elimina `upsert_product_catalog`, `replace_product_unit_conversions`, `ensure_product_category`, `normalize_category_code`, los triggers `trg_products_unit_guard` y `trg_products_category_guard` y sus funciones.
  2. Borrar `server/modules/products/app/{upsertCatalog,replaceConversions,getConversions}.ts` y los métodos equivalentes de `supabaseProductsRepository.ts`.
  3. Quitar `ENGINE_CATALOG` y la rama `db`.
  4. **No** borrar las funciones de unidades (§3.7).
- **Terminado cuando:**
  - `grep` de los nombres borrados no encuentra usos;
  - CI está en verde;
  - los tests de caracterización siguen en verde, ahora solo contra `domain`.

---

## 5. Cómo verificar

```bash
pnpm db:reset
```
```bash
ENGINE_CATALOG=db pnpm vitest run tests/characterization/catalog
```
```bash
ENGINE_CATALOG=domain pnpm vitest run tests/characterization/catalog
```
```bash
pnpm vitest run layers/core/server/contexts/catalog
```
```bash
pnpm lint && pnpm typecheck && pnpm depcruise
```

Playwright: crear un producto con categoría nueva, editar su precio, configurar «caja = 12» e importar un Excel de 3 filas.

---

## 6. Cómo volver atrás

- **Hasta F3-T9:** `ENGINE_CATALOG=db` devuelve todo al comportamiento anterior al instante.
- **F3-T2** es aditiva: las columnas nuevas no rompen nada si se vuelve al motor `db`.
- **F3-T10** es irreversible en la práctica. Solo se ejecuta tras el periodo estable. Antes: `pnpm db:backup`. Si hiciera falta, las funciones se restauran desde `baseline.sql`.

---

## 7. Riesgos

| # | Riesgo | Mitigación |
|---|---|---|
| R1 | Las RPC antiguas exigen `auth.uid()`; con conexión directa (`app_backend`) es nulo y fallan con «No autenticado» | Resolverlo en la Fase 2: mantener el camino `db` por el cliente de usuario de Supabase, **o** fijar `request.jwt.claims` con `set_config` en la transacción para que `auth.uid()` funcione. Bloquea F3-T8 |
| R2 | El upsert por SKU (C4) sobrescribe un producto existente al importar un Excel | Se conserva por compatibilidad; la importación muestra «actualizará N productos existentes». Mejora propuesta |
| R3 | `LegacyStockOverridePort` sigue permitiendo cambiar el stock sin movimiento | Documentado y temporal; la Fase 5 lo elimina. Mientras tanto, solo con `products.edit` |
| R4 | Dos altas simultáneas generan el mismo SKU | Índice único + reintento (F3-T7) |
| R5 | El índice de búsqueda deja de actualizarse si el dominio escribe columnas distintas | El dominio escribe `name`, `brand`, `category_id`, `product_type` y `active` como hoy; test C14 |
| R6 | Normalización distinta entre TS y SQL (tildes, espacios) | Mismos ejemplos en los tests unitarios (F3-T5) y de caracterización (C5–C7); las funciones SQL de unidades conviven hasta la Fase 6 |

### Mejoras propuestas (fuera de esta fase, requieren decisión)

- Aceptar el plural `-es` en las unidades (`unidades` → `unidad`).
- Permitir quitar la categoría de un producto.
- Recalcular o advertir sobre las conversiones al cambiar la unidad base.
- Mensaje claro ante unidades duplicadas en lugar del error de unicidad.
- Que la importación Excel no haga upsert silencioso por SKU.

---

## 8. Registro de cambios

| Fecha | Cambio |
|---|---|
| 2026-11-18 | Consolidación: el camino de las RPC antiguas con `auth.uid()` queda resuelto por D46 (el interruptor `db` usa el cliente de usuario); precio base en `product_prices` (D51); `min_stock` pasa a inventario por ubicación (D52); el cajero deja de editar productos (D45, adelantado en F0-T9). |
| 2026-11-18 | Documento inicial, escrito antes de implementar. |
