# Fase 4 — Precios e impuestos

> **Estado:** Por validar al iniciar · **Detalle:** por caso de uso + modelo de dominio
> **Arquitectura:** [`../arquitectura.md`](../arquitectura.md) — D2, D3, D9, D13, D35, D38, D45; §5.1 (contexto `pricing`), §6, §18.1.
> Las referencias `archivo:línea` son del 2026-11-18 y se revalidan en F4-T1.

---

## 1. Objetivo y alcance

Crear el contexto **`pricing`** y llevar al dominio TypeScript, como **función pura**, la resolución de precio que hoy hace `resolve_sale_item_pricing`. Además:
- agregar el **modelo de impuestos** (D9, D38);
- llevar el **ajuste manual** (hoy dentro de `create_sale`) a una función del dominio;
- **unificar el precio de las listas escolares**, que hoy usa otra lógica.

**Entra:**
- `resolvePrice` (una línea) y `resolvePrices` (lote: carrito completo).
- `applyManualAdjustment`, `computeLineTax`, `setBasePrice` y `listPriceOptions`.
- Validaciones al crear o editar reglas, incluidos los solapamientos.
- Cambio de los consumidores en TypeScript: POS, agente, listas escolares.
- Prueba de **paridad** entre TS y SQL mientras `create_sale` siga en la BD.

**No entra:**
- Registrar ventas ni guardar los impuestos en la venta: Fase 6. Aquí solo se calculan.
- Borrar `resolve_sale_item_pricing` y `customer_group_for_sale`: los usan `create_sale` y `create_sales_order` hasta la Fase 6.
- Envío a SUNAT: módulo `einvoice-pe`.

---

## 2. Requisitos previos

- Fase 3 terminada: `catalog.convertUnit` y `resolveUnitCode` disponibles.
- `tenant_settings` (Fase 2) con `currency`, `price_includes_tax`, `default_tax_rate`. Esta fase agrega `default_customer_group` si la Fase 2 no lo hizo.
- `Money` y `Quantity` sobre la librería decimal (D38).
- Permiso `pricing.edit` (D45: solo el dueño).

---

## 3. Modelo de dominio

### 3.0 Comportamiento actual (reglas exactas)

**`resolve_sale_item_pricing(product, unit, qty_uom, customer, sale_at)`** (`baseline.sql:1467`). Las reglas se aplican **en este orden**, y **cada una sobrescribe a la anterior**:

| # | Regla |
|---|---|
| R0 | **Entradas:** `unit` vacía → unidad base. `qty_uom` nula o ≤ 0 → **1**. `sale_at` por defecto `now()` |
| R1 | **Unidad:** `require_uom_code(unit)`; `factor = resolve_product_uom_factor` (error si no está configurada). `qty_base = qty_uom × factor` |
| R2 | **Grupo de cliente** (`customer_group_for_sale`, `:730`): sin cliente, sin grupo, o grupo inexistente o inactivo → `'minorista'` |
| R3 | **Precio base por unidad base** = el precio `retail` vigente más reciente de `product_prices` (vía la vista `product_catalog`); si no hay, `products.sale_price`; si no, 0. **Moneda** = la de ese precio, o `PEN` |
| R4 | **Precio por grupo de cliente** (`product_customer_group_prices`, por unidad base).<br>• Candidatas: activas; `customer_group` nulo **o** igual al del cliente; `starts_at` nulo o ≤ `sale_at`; `ends_at` nulo o ≥ `sale_at`.<br>• Orden: grupo exacto primero → `priority` asc → `starts_at` desc (nulos al final) → `created_at` desc.<br>• Gana la primera: `price_base = unit_price_base`.<br>• **Una regla con grupo nulo aplica a todos los clientes** |
| R5 | `price_uom = price_base × factor` |
| R6 | **Precio por presentación** (`product_presentation_prices`, por unidad de venta).<br>• Mismos filtros y orden que R4, más `unit_name = unidad resuelta` **por texto exacto**: una regla guardada como `Caja` en vez de `caja` nunca aplica.<br>• Si hay: `price_uom = price_uom de la regla`; `price_base = price_uom / factor` |
| R7 | **Mayorista** (`product_wholesale_tiers`, por unidad base).<br>• Candidatas: activas, `min_qty_base ≤ qty_base` **de esta línea**, más los filtros de grupo y fechas.<br>• Orden: `min_qty_base` desc (el tramo más alto alcanzado) → grupo exacto → `priority` → `created_at` desc.<br>• Si hay: `price_base = tramo`; `price_uom = price_base × factor`.<br>• **Sobrescribe al precio por presentación aunque este sea más barato** |
| R8 | **Promoción** (`product_promotions`).<br>• Candidatas: activas, `min_qty_base ≤ qty_base`, `starts_at ≤ sale_at` (obligatorio), `ends_at` nulo o ≥, grupo nulo o igual, `unit_name` nulo o igual.<br>• Orden: grupo exacto → unidad exacta → `priority` → `starts_at` desc → `created_at` desc.<br>• `percent`: `price_uom × (1 − v/100)`. `fixed_price_uom`: `price_uom = v`, **aunque sea mayor que el precio que había**.<br>• Luego `price_base = price_uom / factor` |
| R9 | **Redondeo:** `price_uom` y `price_base` a **4 decimales**, mínimo 0. Un porcentaje > 100 da precio 0 |
| R10 | **Salida:** `price_uom`, `price_base`, `factor`, `qty_base`, `unit_name`, `base_unit`, `customer_group`, `currency`, `source` (`base`/`customer_group`/`presentation`/`wholesale`, más `+promo_percent`/`+promo_fixed`) y `rule_type` |
| R11 | La **moneda de las reglas se ignora** (`product_customer_group_prices.currency` no se filtra) |
| R12 | Los límites de fecha son **inclusivos** |

**Ajuste manual** (dentro de `create_sale`, `baseline.sql:326-395`). Lo usará la Fase 6:

| # | Regla |
|---|---|
| M1 | Entradas por línea: `manual_discount_pct ≥ 0`, `manual_discount_amount ≥ 0` (por unidad de venta), `price_unit` explícito opcional (≥ 0) y `manual_discount_reason` |
| M2 | Si `pct > 0`, `amount > 0`, o `|price_unit − automático| > 0.0001`: exige rol dueño o encargado (permiso `sales.manual_discount`) **y** un motivo no vacío |
| M3 | `final = automático × (1 − pct/100) − amount`. Si `price_unit` difiere del automático, **`final = price_unit`** (anula el porcentaje y el monto) |
| M4 | `final` redondeado a 4 decimales; si es < 0, error `Precio final inválido` |
| M5 | `price_base = round(final / factor, 4)` |

**Totales hoy:**
- `total` de la línea = `qty_uom × final`, guardado en `numeric(12,2)`.
- Total de la venta = **suma de las líneas sin redondear**, redondeada al final.
- **No hay IGV:** existen `products.taxable` y `products.tax_code` (`baseline.sql:2235-2236`), pero ningún código los usa.

**Listas escolares en `main`.** `server/api/school/all-lists-stock.get.ts` y `stock-analysis.get.ts` usan `sale_price` para valorar listas y comparar marcas. Los resultados pueden diferir del precio del POS por grupo de cliente, cantidad o promoción. El baseline contiene campos de presentación y precio en `school_list_item_brands`. Verificar su uso y los datos existentes antes de retirarlos.

**Edición de reglas** (`supabasePricingRepository.ts`): sin validaciones más allá de que existan los ids. Se puede guardar una presentación con una unidad no configurada, un porcentaje > 100 o reglas idénticas que se pisan.

### 3.1 Entidades y objetos de valor

| Elemento | Tipo | Contenido |
|---|---|---|
| `BasePrice` | Agregado (historial) | `productId`, `priceList='retail'`, `amount: Money`, `validFrom`, `validTo?`, `isCurrent`. Fuente única del precio base (§3.5) |
| `RuleScope` | Valor | `productId`, `customerGroup \| null` (nulo = todos), `validity {startsAt?, endsAt?}`, `priority`, `active`, `createdAt` |
| `CustomerGroupPrice` | Regla | `scope` + `unitPriceBase: Money` |
| `PresentationPrice` | Regla | `scope` + `unit: UnitCode` + `priceUom: Money` |
| `WholesaleTier` | Regla | `scope` + `minQtyBase: Quantity` + `unitPriceBase: Money` |
| `Promotion` | Regla | `scope` (con `startsAt` obligatorio) + `name` + `unit?: UnitCode` + `kind: percent \| fixed_price_uom` + `value: Decimal` + `minQtyBase: Quantity` |
| `PriceResolution` | Valor (resultado) | Los campos de R10 + `appliedRuleIds` (nuevo, para auditoría en `pricing_detail`) |
| `ManualAdjustment` | Valor | `pct`, `amount`, `explicitPrice?`, `reason?` |
| `LinePrice` | Valor | `autoPriceUom`, `finalPriceUom`, `finalPriceBase`, `adjusted: boolean` |
| `TaxCategory` | Valor | `taxed` (gravado, SUNAT 10) · `exempt` (exonerado, 20) · `unaffected` (inafecto, 30) |
| `TaxBreakdown` | Valor | `category`, `rate`, `taxableAmount`, `taxAmount`, `total` |

### 3.2 Funciones puras del dominio

```ts
resolvePrice(input: {
  product: { id; baseUnit; conversions; taxCategory },
  basePrice: Money,
  rules: { customerGroup[]; presentation[]; wholesale[]; promotions[] },
  customerGroup: string,          // ya resuelto (R2)
  unit: UnitCode, qtyUom: Quantity, at: Date
}): PriceResolution                // R0–R12, idéntico a SQL

applyManualAdjustment(auto: PriceResolution, adj: ManualAdjustment,
  canAdjust: boolean): LinePrice   // M1–M5

computeLineTax(lineTotal: Money, category: TaxCategory,
  settings: { rate; priceIncludesTax }): TaxBreakdown

resolveCustomerGroup(customer?, activeGroups, defaultGroup): string   // R2
```

### 3.3 Modelo de impuestos (nuevo, D9, D13, D38)

1. **Configuración por negocio:**
   - `tenant_settings.price_includes_tax = true`;
   - `default_tax_rate = 0.18` (IGV de Perú; configurable porque la tasa puede cambiar por ley);
   - `default_customer_group = 'minorista'`. Hoy está fijo en `customer_group_for_sale`; pasa a ser configurable.
2. **Por producto:** `products.tax_category`, inicializada desde `taxable` (`true` → `taxed`, `false` → `exempt`). Se elimina `taxable` y `tax_code` en la Fase 7.
3. **Por línea** (redondeo por línea, D38):
   - `lineTotal = round2(qty_uom × finalPriceUom)`;
   - si la categoría es `taxed` y el precio incluye impuesto: `taxable = round2(lineTotal / (1 + rate))` y `tax = lineTotal − taxable`;
   - si es `taxed` y el precio excluye impuesto: el importe calculado es la base, `tax = round2(base × rate)` y `lineTotal = base + tax`;
   - si la categoría es `exempt` o `unaffected`: `taxable = lineTotal` y `tax = 0`.
4. **Documento:**
   - `total = Σ lineTotal`;
   - `taxTotal = Σ tax`;
   - `taxableTotal = Σ taxable`, agrupado por categoría.
5. El motor histórico redondea la suma al final; el nuevo suma líneas redondeadas. Cinco líneas de 1,004 dan respectivamente 5,02 y 5,00. Los tests comparan cada resultado exacto contra su regla (D56).
6. **SUNAT** exige reglas finas de redondeo (valor unitario con hasta 10 decimales). Se **validan con el proveedor de facturación** antes del módulo `einvoice-pe`; esta fase deja `computeLineTax` aislada para poder ajustarla sin tocar `resolvePrice`.

### 3.4 Invariantes de las reglas (validaciones al crear y editar)

| # | Validación | Hoy |
|---|---|---|
| V1 | Montos ≥ 0; `minQtyBase > 0`; `value > 0` | Lo cumplen los `CHECK` |
| V2 | `percent`: `0 < value ≤ 100` | No se valida (R9 lo convierte en 0) |
| V3 | `PresentationPrice.unit` y `Promotion.unit` deben ser la base o una conversión **activa** del producto, guardadas como **código canónico** | No se valida (R6 falla en silencio) |
| V4 | `startsAt < endsAt` cuando ambas existen | No se valida |
| V5 | `customerGroup` existe y está activo en el negocio | No se valida |
| V6 | **Solapamiento:** se rechaza una regla del mismo tipo, producto y grupo (y unidad, o `minQtyBase` en mayorista) con **la misma prioridad** y vigencias que se cruzan. Con prioridad distinta se permite, porque el orden es explícito | No se valida (el empate se resuelve en silencio por `created_at`) |

### 3.5 Decisiones de esta fase (por confirmar en F4-T1)

- **Fuente única del precio base:** `product_prices` (historial), del contexto `pricing`.
  - `products.sale_price` queda como **copia derivada** hasta la Fase 7, porque la vista y `create_sale` la usan, y luego se elimina.
  - `catalog.saveProduct` deja de usar `LegacyBasePricePort` y llama a `pricing.setBasePrice`.
- **Las reglas actuales se conservan tal cual,** incluidas las sorprendentes (R4 con grupo nulo, R7 sobre la presentación, R8 fijo mayor que el precio). Cambiarlas es una decisión de negocio aparte («Mejoras propuestas»).
- **Listas escolares:**
  - el precio se calcula con `resolvePrice` en el momento de la cotización (grupo por defecto del negocio, o el del cliente si se conoce);
  - `pricing_rule_id` y `pricing_unit_name` se conservan como **presentación preferida**;
  - `pricing_price_uom` deja de usarse y se elimina en la Fase 8, cuando la papelería pase a ser un módulo vertical.

### 3.6 Eventos

| Evento | Cuándo |
|---|---|
| `BasePriceChanged` | `setBasePrice` cambia el precio vigente |
| `PriceRuleChanged` | Alta, edición o baja de cualquier regla (incluye tipo y producto) |

Se usan para invalidar cachés del POS y del agente y, en el futuro, para avisos al módulo de cotizaciones.

### 3.7 Casos de uso

| Caso de uso | Reemplaza | Notas |
|---|---|---|
| `resolvePrice(productId, unit, qty, customerId?, at?)` | `resolve_sale_item_pricing` (para el código TS) | Carga datos y llama a la función pura |
| `resolvePrices(lines[], customerId?)` | N llamadas en serie desde `pages/sales.vue` (`refreshCartPricing`) (auditoría P6) | **Una** consulta de reglas para todos los productos |
| `setBasePrice(productId, amount)` | Pasos 8–9 de `upsert_product_catalog` (puerto temporal de la Fase 3) | Historial + copia derivada |
| `createRule` / `updateRule` / `deleteRule` (por tipo) | `supabasePricingRepository.ts` y `server/modules/pricing/app/*` | Con las validaciones V1–V6 |
| `getRules(productId)` / `getCatalogs()` | Lecturas actuales | Consultas |
| `listPriceOptions(productId, customerId?)` | Nuevo contrato de consulta para los consumidores que requieran elegir presentación | Una opción por unidad con su precio resuelto |
| `applyManualAdjustment` / `computeLineTax` | Parte de `create_sale` | Expuestas en `pricing/index.ts`; las consume la Fase 6 |

---

## 4. Tareas

### F4-T1 — Validación de inicio de fase
Aplicar la regla de `fases/README.md`. Además:
- confirmar las decisiones de §3.5;
- confirmar la tasa de IGV vigente;
- decidir si la cotización escolar usa el grupo del cliente cuando se conoce.

**Terminado cuando:** el estado de la fase es «Validada».

### F4-T2 — Auditoría de datos de reglas
- **Objetivo:** saber qué datos actuales violan V2–V6 antes de activar las validaciones.
- **Archivos:** `scripts/audit/pricing-rules.sql` (solo lectura).
- **Pasos:** consultas que listan:
  - presentaciones o promociones con `unit_name` que no es un código canónico o no está configurado;
  - porcentajes > 100;
  - `starts_at ≥ ends_at`;
  - grupos inexistentes;
  - empates de solapamiento;
  - reglas con moneda ≠ la del negocio.
- **Terminado cuando:** existe un informe revisado con el dueño y los datos corregidos o aceptados. Las reglas con unidad mal escrita **hoy no aplican**: corregirlas **cambia precios**, y el dueño decide cada una.

### F4-T3 — Migración de impuestos y configuración
- **Archivos:** `supabase/migrations/<fecha>_pricing_tax_settings.sql`, esquema Drizzle.
- **Pasos:**
  1. `products.tax_category text NOT NULL DEFAULT 'taxed' CHECK (...)`, inicializada desde `taxable`.
  2. Columnas de `tenant_settings` que falten (`price_includes_tax`, `default_tax_rate`, `default_customer_group`).
- **Terminado cuando:** las migraciones aplican limpias y se hizo `pnpm db:backup` antes de producción.

### F4-T4 — Tests de caracterización (matriz de precios)
- **Archivos:** `tests/characterization/pricing/resolvePrice.test.ts`, datos en `seed.sql`.
- **Producto de prueba P:**
  - base `unidad`; `caja = 12`; `paquete = 6`;
  - precio `retail` vigente 1,50; `products.sale_price` = 1,40, a propósito distinto;
  - grupos `minorista` y `mayorista` (activos) e `institucional` (inactivo).

| # | Caso | Esperado (`price_uom` / `source`) |
|---|---|---|
| P1 | Sin reglas, 1 unidad | 1,5000 / base |
| P2 | Producto sin `product_prices` | 1,4000 (`sale_price`) |
| P3 | Sin reglas, 1 caja | 18,0000; `price_base` 1,5000 |
| P4 | Sin cliente | grupo `minorista` |
| P5 | Cliente del grupo `institucional` (inactivo) | grupo `minorista` |
| P6 | Regla `mayorista` 1,20; cliente mayorista | 1,2000 / customer_group |
| P7 | Regla de grupo nulo (prio 50) a 1,30 + regla `mayorista` (prio 100) a 1,20; cliente mayorista | 1,2000 (gana el grupo exacto) |
| P8 | Regla de grupo nulo a 1,30; cliente minorista | 1,3000 (aplica a todos) |
| P9 | Regla vencida ayer / que empieza mañana / `ends_at = sale_at` | se ignora / se ignora / aplica |
| P10 | Presentación caja 16,00 | 16,0000; `price_base` 1,3333 / presentation |
| P11 | Presentación guardada como `Caja` | No aplica: 18,0000 |
| P12 | Grupo 1,20 + presentación caja 16,00; 1 caja, cliente mayorista | 16,0000 (la presentación sobrescribe) |
| P13 | Presentación caja 12,00 + tramo `min 24` a 1,10; 2 cajas | 13,2000 / wholesale (sobrescribe a la presentación más barata) |
| P14 | Tramos `min 12` a 1,30 y `min 24` a 1,10; 20 u / 30 u | 1,3000 / 1,1000 |
| P15 | Tramo `min 24`; dos líneas de 12 u | Cada línea a 1,50 (el tramo es por línea) |
| P16 | Promoción 10 % | 1,3500 (unidad) / 16,2000 (caja) |
| P17 | Promoción `fixed_price_uom` 20,00 en caja (automático 18,00) | 20,0000 (sube el precio) |
| P18 | Promoción 150 % | 0,0000 |
| P19 | Promoción general 10 % + promoción solo caja 5 %; 1 caja | 17,1000 (gana la unidad exacta) |
| P20 | Promoción `min_qty_base 12`; 1 unidad | No aplica |
| P21 | `qty` 0 o negativa | Se evalúa como 1 |
| P22 | Unidad `''` / `docena` (sin configurar) | Base / error |
| P23 | Presentación 10,00 con factor 3 | `price_base` 3,3333 |

- **Ajuste manual** (pruebas de `applyManualAdjustment`, contrastadas con `create_sale` en la Fase 6):
  - M-a: cajero con `pct > 0` → error de rol.
  - M-b: encargado sin motivo → error.
  - M-c: 18,00 con 10 % y 0,50 → 15,7000.
  - M-d: `price_unit` 15 con 10 % → 15,0000.
  - M-e: `price_unit` igual al automático, cajero → permitido sin motivo.
  - M-f: resultado negativo → error.
- **Impuestos** (nuevos, sin equivalente actual):
  - T-a: 3 × 1,35 = 4,05 gravado al 18 % → base 3,43; IGV 0,62.
  - T-b: exonerado → base 4,05; IGV 0.
  - T-d: precio sin impuesto de 10,00 al 18 % → base 10,00, impuesto 1,80, total 11,80. Comprobar también el ejemplo de cinco líneas de §3.3.
  - T-c: venta de 3 líneas → totales iguales a la suma de líneas.
- **Terminado cuando:** P1–P23 pasan contra la función SQL (llamada directa a `resolve_sale_item_pricing`).

### F4-T5 — Dominio
- **Archivos:** `layers/core/server/contexts/pricing/domain/{rules.ts, resolvePrice.ts, manualAdjustment.ts, tax.ts, customerGroup.ts, errors.ts}` + tests.
- **Pasos:**
  1. Implementar §3.1–§3.4 con `Money`/`Quantity`.
  2. La matriz P1–P23 como tests unitarios de la función pura.
  3. Tests de propiedades: el precio nunca es negativo; la misma entrada da la misma salida.
- **Terminado cuando:** el dominio no tiene imports externos y la matriz está en verde.

### F4-T6 — Aplicación, puertos e infraestructura
- **Archivos:** `contexts/pricing/application/*`, `contexts/pricing/infrastructure/drizzle*.ts`, `contexts/pricing/index.ts`.
- **Puertos:** `PriceRuleRepository` (carga en lote por lista de productos), `BasePriceRepository`, `CustomerGroupRepository`, `TenantSettingsPort`, `CatalogPort` (usa `catalog/index.ts`: `convertUnit`, conversiones), `EventPublisher`, `UnitOfWork`, `Clock`.
- **Pasos:**
  1. `resolvePrices` hace **una** consulta por tipo de regla para todos los productos del lote.
  2. Las consultas filtran por `active` y vigencia en SQL, y la decisión final se toma en la función pura.
  3. `setBasePrice` escribe el historial y la copia derivada `products.sale_price`.
- **Terminado cuando:** hay tests de integración en verde y `resolvePrices` de 20 líneas responde en < 150 ms en local.

### F4-T7 — Prueba de paridad en CI (hasta la Fase 6)
- **Objetivo:** mientras `create_sale` use la función SQL, el POS (TS) y la venta registrada (SQL) deben dar el mismo precio.
- **Archivos:** `tests/parity/pricing.test.ts`.
- **Pasos:**
  1. Ejecutar P1–P23 y una muestra aleatoria de productos y reglas del seed contra **ambas** implementaciones.
  2. Comparar los campos de R10.
  3. Afirmar por separado el resultado exacto de impuestos y redondeo de §3.3 tanto para el cálculo vigente como para el nuevo.
- **Terminado cuando:** la prueba es obligatoria en CI. **Se elimina en la Fase 6**, junto con la función SQL.

### F4-T8 — Rutas HTTP
- **Archivos:**
  - `layers/core/server/api/sales/resolve-pricing.post.ts` (compatible)
  - `layers/core/server/api/pricing/resolve-batch.post.ts` (nuevo)
  - `layers/core/server/api/pricing/**` (reglas, catálogos)
  - esquemas en `shared/schemas/pricing.ts`
- **Pasos:**
  1. Lectura de precios: cualquier sesión del negocio.
  2. Edición de reglas: `permission: 'pricing.edit'`.
  3. Interruptor `ENGINE_PRICING=db|domain` en `resolve-pricing`.
  4. La edición de reglas pasa directo al dominio, porque solo agrega validaciones (V2–V6).
  5. En `resolve-pricing`, ignorar `sale_at` enviado por el cliente salvo para el dueño (hoy el POS puede enviar cualquier fecha).
- **Terminado cuando:** las pruebas de las rutas están en verde y la página de precios funciona con los mensajes de validación nuevos.

### F4-T9 — Cambiar los consumidores
- **Archivos:**
  - `server/modules/sales/infra/supabaseSalesRepository.ts:94`
  - `server/modules/agent/infra/supabaseAgentCatalog.ts:161`
  - `server/api/school/{all-lists-stock.get.ts,stock-analysis.get.ts}`
  - `pages/sales.vue` (`refreshCartPricing`)
- **Pasos:**
  1. POS y agente → `pricing.resolvePrice` / `resolvePrices`, con interruptor.
  2. El agente sigue verificando el precio oficial (principio «la IA interpreta, el código verifica»).
  3. Listas escolares → `listPriceOptions` / `resolvePrices`.
  4. Verificar que la valoración de la lista y el POS aplican el mismo precio para igual negocio, cliente, cantidad, unidad y momento.
  5. El POS reprecia el carrito con **una** llamada a `resolve-batch`.
- **Terminado cuando:**
  - `pnpm test:agent` está en verde;
  - un cambio de regla se ve **al momento** en la cotización escolar;
  - el repreciado del carrito usa una sola petición.

### F4-T10 — Activación gradual y limpieza
- **Pasos:**
  1. `ENGINE_PRICING=domain` primero en staging y luego en producción, con 2 semanas de observación.
  2. Borrar `server/modules/pricing/app/*` (solo reenvían) y el repositorio antiguo.
  3. **No** borrar `resolve_sale_item_pricing` ni `customer_group_for_sale`: van en la lista de limpieza de la Fase 6.
- **Terminado cuando:** CI está en verde, la paridad está en verde y nada de TS llama a la RPC.

---

## 5. Cómo verificar

```bash
pnpm vitest run layers/core/server/contexts/pricing
```
```bash
pnpm vitest run tests/characterization/pricing tests/parity/pricing.test.ts
```
```bash
pnpm test:agent
```

Playwright:
1. Crear una promoción del 10 % para la caja.
2. En el POS, agregar 2 cajas: se ve el precio con promoción.
3. Cambiar al cliente mayorista: el carrito se reprecia con **1** petición.
4. Abrir una cotización escolar: refleja la promoción.

---

## 6. Cómo volver atrás

- `ENGINE_PRICING=db` devuelve el POS y el agente a la RPC. Las listas escolares no tienen interruptor: se revierte su PR.
- Las validaciones V2–V6 solo afectan a reglas **nuevas o editadas**; quitarlas es revertir un PR.
- F4-T3 es aditiva.

---

## 7. Riesgos

| # | Riesgo | Mitigación |
|---|---|---|
| R1 | TS y SQL divergen y el POS muestra un precio distinto del que registra la venta | Prueba de paridad obligatoria (F4-T7) hasta la Fase 6 |
| R2 | Corregir unidades mal escritas en reglas (F4-T2) cambia precios reales | Cada corrección la aprueba el dueño; se comunica antes |
| R3 | Las cotizaciones escolares cambian de precio porque dejan de usar el precio guardado | Avisar al dueño; comparar las cotizaciones de las listas activas antes y después |
| R4 | El redondeo del IGV no coincide con SUNAT | `computeLineTax` aislada; validar con el proveedor antes de `einvoice-pe` |
| R5 | Rendimiento del lote con muchas reglas | Consultas por lote y con índices `(tenant_id, product_id, active)` en las tablas de reglas (coordinar con la Fase 7) |
| R6 | Las RPC antiguas y `auth.uid()` con conexión directa | Mismo R1 de la Fase 3, resuelto en la Fase 2 |

### Mejoras propuestas (decisión de negocio, fuera de esta fase)

- Que el mayorista **no** sobrescriba un precio por presentación más barato: usar el menor, o un orden configurable.
- Que una promoción de precio fijo nunca suba el precio.
- Que una regla de grupo nulo se distinga de forma explícita como «para todos» en la interfaz.
- Tramos mayoristas por **carrito** (suma de líneas del mismo producto) en lugar de por línea.
- Filtrar las reglas por moneda cuando haya varias monedas (D13).

---

## 8. Registro de cambios

| Fecha | Cambio |
|---|---|
| 2026-11-18 | Se documentan ambos modos de precio y casos exactos de redondeo acumulado. |
| 2026-11-18 | Consolidación: D51 (fuente única del precio, `tax_category`, `default_customer_group`) y D56 (diferencia de ±0,01 por redondeo por línea, tolerada en los tests). El precio manual queda sujeto a `sales.manual_discount`, concedible por usuario (D57). |
| 2026-11-18 | Documento inicial, escrito antes de implementar. |
