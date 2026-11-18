# Fase 5 — Compras e inventario

> **Estado:** Por validar al iniciar · **Detalle:** por caso de uso + modelo de dominio
> **Arquitectura:** D7 (ubicaciones), D20 (stock con una sola fuente), D23 (`pg_cron`), D38 (decimales), D39 (stock negativo bloqueado), D41 (ajuste positivo), §5, §6.3, §8.3, §10.1.
> Las referencias `archivo:línea` corresponden al repositorio al 2026-11-18 y se revalidan al iniciar la fase.

---

## 1. Objetivo y alcance

**Objetivo.** Llevar al dominio en TypeScript (contextos `purchasing` e `inventory`) todo lo que hoy registra compras, mueve stock y calcula costos. Al terminar, se cumplen tres cosas:
- el stock tiene **una sola fuente de verdad** por producto y ubicación;
- el FIFO **siempre cuadra** con el stock;
- toda escritura de inventario es **atómica y segura ante concurrencia**.

**Entra:**
- registrar y corregir compras;
- libro de movimientos de stock;
- lotes FIFO y costo promedio;
- conteos de inventario (iniciar, aplicar, cerrar);
- reservas persistentes;
- transferencias entre ubicaciones;
- conciliación y migración de datos a la fuente única;
- evento `StockBajo`;
- retiro de `create_purchase` y del código de compras e inventario que escribe directo.

**No entra:**
- la venta y el consumo FIFO **desde la venta** (Fase 6). El consumo FIFO como función del dominio sí se construye aquí, y la Fase 6 lo usa.
- cotizaciones de proveedor (`suppliers/quotes/*`): siguen como CRUD (§5.1). Si en el futuro «aceptar cotización» crea la compra, será un caso de uso nuevo de `purchasing`.
- la interfaz de transferencias entre ubicaciones: queda oculta hasta habilitar la segunda ubicación (ver T11).

### 1.1 Comportamiento actual (verificado en el código)

Esto es lo que los tests de caracterización (T1) deben fijar antes de reemplazar nada.

**`create_purchase`** (`baseline.sql:69`):

| # | Regla actual |
|---|---|
| P1 | Exige `auth.uid()`. **No valida rol**: cualquier usuario autenticado registra compras. La matriz §10.1 lo limita a dueño y encargado |
| P2 | `p_items` debe ser un arreglo. Por ítem: `qty > 0`, `cost_unit >= 0`, el producto existe |
| P3 | Unidad: sin `unit_name` se usa la unidad base del producto (`require_uom_code`). `factor = resolve_product_uom_factor`, `qty_base = qty × factor`, `cost_base = cost / factor` |
| P4 | Crea la fila de `inventory_balances` si no existe (stock 0, promedio 0) y la bloquea con `FOR UPDATE` |
| P5 | Costo promedio ponderado: `nuevo_prom = (stock_ant × prom_ant + qty_base × cost_base) / stock_nuevo`; 0 si el stock nuevo es 0 |
| P6 | Escribe stock y promedio **en dos lugares**: `inventory_balances` y `products` |
| P7 | `purchase_items`: guarda `qty_uom`, `factor_to_base`, `cost_unit_uom`, `qty` (base), `cost_unit` (base) y `total_cost = qty × cost` (sin redondeo explícito; la columna `numeric(12,2)` redondea) |
| P8 | Crea un lote FIFO: `source='purchase'`, `layer_date = purchase_date`, `qty_in = qty_remaining = qty_base`, `cost_unit = cost_base` |
| P9 | Movimiento `purchase` con `+qty_base` y `cost_base`, referencia `purchases` |
| P10 | `purchases.total_cost` = suma sin redondear de `qty × cost`, redondeada al guardar |
| P11 | La fecha es siempre `now()`: no se puede registrar una compra con fecha pasada |

**Corrección de compra** (`api/purchases/items.patch` → `supabasePurchasesRepository.ts:100-197`):

| # | Regla actual |
|---|---|
| PC1 | Actualiza solo `unit_name`, `qty_uom`, `cost_unit_uom` y `total_cost`, una fila a la vez, y luego el total de la compra. **No es atómico** |
| PC2 | La función `purchase_items_sync_base_fields` existe en la BD, pero **su trigger fue eliminado** en scripts antiguos (`archive/legacy-sql/schema.sql:1019`). Por eso `qty` y `cost_unit` (base) **no se recalculan** |
| PC3 | **No toca** el lote FIFO, el saldo, el costo promedio ni el movimiento. Corregir una compra descuadra en silencio stock, FIFO y costos |

**Conteo de inventario** (`supabaseInventoryRepository.ts:80-262`):

| # | Regla actual |
|---|---|
| I1 | Una sola sesión abierta a la vez: consulta y luego inserta, sin bloqueo (dos usuarios pueden abrir dos) |
| I2 | `applyAdjustment` lee el stock de la vista `product_catalog` y **trunca a entero** (`toInt`, línea 14). El stock fraccionado (metros, kilos) se pierde |
| I3 | Delta = conteo − stock del sistema leído **en ese momento**. Escribe el valor **absoluto** en `inventory_balances` y en `products` |
| I4 | Movimiento `adjust` al costo promedio. **No consume lotes FIFO** (delta negativo) **ni los crea** (delta positivo): el FIFO deja de cuadrar |
| I5 | Son 3 o 4 escrituras separadas, sin transacción ni bloqueo. Si entre la lectura y la escritura ocurre una venta, esa venta se pierde del stock (se pisa con un valor absoluto calculado antes) |
| I6 | `non_sellable` se guarda pero no se descuenta de nada |
| I7 | Cerrar sesión solo cambia el estado |

**Otras escrituras de stock fuera del inventario:**
- `upsert_product_catalog` (`baseline.sql:1832`) puede fijar `stock_on_hand` y `avg_cost` **directo** en `inventory_balances` y en `products`, sin movimiento ni lote. Se resuelve en coordinación con la Fase 3 (T13).
- `create_sale` crea un lote `auto-balance` cuando faltan lotes FIFO, y `pay_sales_order` **no consume FIFO**. Ambos se corrigen en la Fase 6.

---

## 2. Requisitos previos

- [ ] Fase 2 terminada: `tenant_id` en todas las tablas, tabla `locations` con una ubicación principal por negocio, RLS por negocio, rol `app_backend`.
- [ ] Fase 3 terminada: `item_kind` (bien, servicio, kit), `Quantity` y conversión de unidades en el dominio (`convertUnit`).
- [ ] Fase 4 terminada: no es estrictamente necesaria para compras, pero el orden del plan la deja antes.
- [ ] `UnitOfWork`, Drizzle y outbox de la Fase 1 funcionando, con test de integración.
- [ ] `supabase/seed.sql` con productos, conversiones, compras y ventas de ejemplo que cubran varios lotes FIFO por producto.
- [ ] Respaldo de producción (`pnpm db:backup`) antes de cada migración (D44).

---

## 3. Modelo de dominio

### 3.1 Entidades

| Entidad (código) | Contexto | Campos clave | Notas |
|---|---|---|---|
| `Purchase` | purchasing | `id`, `tenantId`, `locationId`, `supplierId`, `invoiceNo`, `purchaseDate`, `status` (`registered`), `clientRequestId`, `lines[]`, `total` | `total` = suma de las líneas redondeadas a 2 decimales |
| `PurchaseLine` | purchasing | `productId`, `unitName`, `qtyUom`, `factorToBase`, `qtyBase`, `unitCostUom`, `unitCostBase`, `lineTotal` | Solo `item_kind = good`. Los servicios no entran a compras de inventario |
| `CostLayer` | inventory | `id`, `productId`, `locationId`, `source` (`purchase`, `adjustment`, `return`, `transfer`, `reconciliation`, `auto_balance` heredado), `sourceRef`, `layerDate`, `fifoOrder`, `qtyIn`, `qtyRemaining`, `unitCost` | Inmutable salvo `qtyRemaining` |
| `StockMovement` | inventory | `id`, `productId`, `locationId`, `type`, `qty` (con signo), `unitCost`, `refType`, `refId`, `createdBy`, `createdAt` | **Libro contable**: solo se agrega, nunca se edita ni se borra |
| `StockBalance` | inventory | `productId`, `locationId`, `onHand`, `avgCost`, `reserved`, `minStock` | **Derivado**: lo escriben solo los casos de uso de inventario. `available = onHand − reserved` |
| `Reservation` | inventory | `id`, `productId`, `locationId`, `qtyBase`, `sourceType` (`sales_order`, `quote`, `agent_operation`, `work_order`…), `sourceId`, `expiresAt?`, `status` (`active`, `consumed`, `released`, `expired`) | Reemplaza las reservas en memoria del agente |
| `InventoryCount` | inventory | `id`, `locationId`, `code`, `status` (`open`, `closed`), `lines[]` | Una sesión abierta por ubicación |
| `CountLine` | inventory | `productId`, `systemQtyAtCount`, `countedAt`, `counted`, `nonSellable`, `delta`, `reason`, `reconfirmed`, `applied`, `appliedAt` | |
| `Transfer` | inventory | `id`, `fromLocationId`, `toLocationId`, `lines[]`, `transferredAt` | Inmediata (sin estado "en tránsito") en esta fase |

Tipos de movimiento (amplían el `CHECK` actual `purchase | sale | adjust`):
- `purchase`, `purchase_correction`
- `sale`, `sale_void`, `return` (los usa la Fase 6)
- `adjustment_in`, `adjustment_out`
- `transfer_out`, `transfer_in`
- `reconciliation` (solo en la migración de datos)

### 3.2 Reglas (invariantes)

| # | Invariante |
|---|---|
| INV1 | `StockBalance.onHand` = suma de `StockMovement.qty` del producto en esa ubicación |
| INV2 | `StockBalance.onHand` = suma de `CostLayer.qtyRemaining` del producto en esa ubicación (el FIFO cuadra) |
| INV3 | `onHand >= 0` siempre (D39). Toda salida falla si no alcanza |
| INV4 | Una reserva nueva solo se crea si `available >= qty`. Un documento puede consumir **su propia** reserva |
| INV5 | Toda entrada crea un lote; toda salida consume lotes en orden FIFO (`layerDate`, luego `fifoOrder`) |
| INV6 | Los movimientos y los lotes solo se agregan; de un lote solo cambia `qtyRemaining`, con `0 <= qtyRemaining <= qtyIn` |
| INV7 | El saldo solo lo escriben los casos de uso de `inventory`, dentro del mismo `UnitOfWork` que el movimiento. El catálogo nunca escribe stock |
| INV8 | Cantidades con `Quantity` (3 decimales) y costos unitarios con `Money` (4 decimales); totales a 2 decimales (D38). Nunca `number` de JS |
| INV9 | Los ítems `service` no tienen stock: el inventario los rechaza. Los ítems `kit` se resuelven en sus componentes (lo define la Fase 3) |
| INV10 | El costo promedio se recalcula solo en las entradas, con la fórmula P5. Las salidas no lo cambian (igual que hoy) |
| INV11 | Una compra solo se corrige mientras sus lotes no fueron consumidos (ver decisión pendiente DP5-1) |

### 3.3 Eventos (outbox, §8.3)

| Evento (código) | Cuándo |
|---|---|
| `PurchaseRegistered` (CompraRegistrada) | Al registrar una compra |
| `PurchaseCorrected` | Al corregir una compra |
| `StockAdjusted` (StockAjustado) | Al aplicar una línea de conteo con delta distinto de 0 |
| `StockLow` (StockBajo) | Cuando `available` cruza hacia abajo `minStock` en una ubicación |
| `StockTransferred` | Al registrar una transferencia |
| `ReservationExpired` | Al vencer una reserva |

### 3.4 Casos de uso y qué reemplazan

| Caso de uso (código) | Reemplaza | Permiso (§10.1) |
|---|---|---|
| `registerPurchase` | RPC `create_purchase` | `purchases.register` |
| `correctPurchase` | `api/purchases/items.patch` + función huérfana `purchase_items_sync_base_fields` | `purchases.register` |
| `recordStockMovement` (interno) | Las inserciones directas en `stock_movements` de RPC y repositorios | — (solo lo llaman otros casos de uso) |
| `receiveIntoLayer` (interno) | Inserciones directas en `stock_cost_layers` | — |
| `consumeFifo` (interno) | El bucle FIFO dentro de `create_sale` (lo usa la Fase 6) | — |
| `reserveStock` / `releaseReservation` / `expireReservations` | `agent/app/reservations.ts` (solo en memoria) | Interno; lo llaman pedidos, cotizaciones y el agente |
| `startCount` / `applyCount` / `closeCount` | `supabaseInventoryRepository.ts` (`startSession`, `applyAdjustment`, `closeSession`) | `inventory.count` / `inventory.apply` / `inventory.apply` |
| `transferStock` | Nuevo | `inventory.apply` |
| `getStock` (consulta) | Lecturas de `product_catalog.stock_on_hand` | `products.view` |

---

## 4. Diseño de concurrencia

1. **Orden fijo de bloqueos.** Todo caso de uso que toque varios productos bloquea las filas de `stock_balances` **ordenadas por `(product_id, location_id)`** con `SELECT … FOR UPDATE`. Así se evitan bloqueos mutuos (deadlocks) entre dos compras o ventas con los mismos productos en distinto orden.
2. **Luego los lotes** del producto, con `FOR UPDATE` en orden FIFO (igual que `create_sale` hoy).
3. **Las decisiones se toman después de bloquear.** El delta del conteo, la disponibilidad para reservar y la validación de stock se calculan con los valores leídos **bajo bloqueo**, nunca con lecturas previas (corrige I5).
4. **Conteo con delta relativo.** Al contar una línea se guarda `systemQtyAtCount`. Al aplicar se registra `delta = counted − systemQtyAtCount` como movimiento relativo. Ejemplo: se cuentan 8 cuando el sistema decía 10 y luego se vende 1; el stock queda en 7, no en 8. Es un **cambio de comportamiento** respecto a I3; ver DP5-2.
5. **Una sesión de conteo abierta por ubicación**, garantizada con un índice único parcial (`WHERE status = 'open'`), no con consulta previa (corrige I1).
6. **Idempotencia.** `purchases.client_request_id` es único por negocio; repetir la misma petición devuelve la compra existente (doble clic, reintento de red).

**Tests de concurrencia obligatorios** (Vitest + Supabase local, con conexiones reales en paralelo):
- 20 salidas simultáneas de 1 unidad sobre un stock de 10: exactamente 10 se confirman, 10 fallan con stock insuficiente, el saldo queda en 0 e INV1 e INV2 se cumplen;
- compra y ajuste negativo simultáneos sobre el mismo producto: el resultado final es igual al de ejecutarlos en serie;
- dos reservas simultáneas por el último disponible: solo una se confirma;
- dos transacciones con los productos A y B en orden inverso: ninguna queda bloqueada (sin deadlock);
- abrir dos sesiones de conteo a la vez en la misma ubicación: solo una se crea.

---

## 5. Migración de datos a la fuente única (D20)

El objetivo es que, al terminar, se cumplan INV1, INV2 e INV3 para todos los productos.

### 5.1 Conciliación (solo lectura, T2)

Consulta de diagnóstico; se ejecuta sobre una copia local (`pnpm db:refresh`), **nunca** en staging (D43: sin datos reales) ni directo en producción:

```sql
with mov as (
  select product_id, sum(qty) as qty_movements from stock_movements group by product_id
), lay as (
  select product_id, sum(qty_remaining) as qty_layers, count(*) filter (where source = 'auto-balance') as auto_layers
  from stock_cost_layers group by product_id
)
select p.id, p.sku, p.name,
       p.stock_on_hand            as stock_products,
       ib.stock_on_hand           as stock_balances,
       coalesce(lay.qty_layers, 0)    as stock_layers,
       coalesce(mov.qty_movements, 0) as stock_movements,
       coalesce(lay.auto_layers, 0)   as auto_balance_layers,
       p.avg_cost as avg_products, ib.avg_cost as avg_balances
from products p
left join inventory_balances ib on ib.product_id = p.id
left join lay on lay.product_id = p.id
left join mov on mov.product_id = p.id
where p.stock_on_hand is distinct from ib.stock_on_hand
   or ib.stock_on_hand is distinct from coalesce(lay.qty_layers, 0)
   or ib.stock_on_hand is distinct from coalesce(mov.qty_movements, 0)
   or p.avg_cost is distinct from ib.avg_cost
   or ib.stock_on_hand < 0
order by p.name;
```

El resultado se clasifica en un informe (`docs/fases/anexos/fase-5-conciliacion.md`):

| Caso | Causa probable | Tratamiento |
|---|---|---|
| `stock_products ≠ stock_balances` | Escritura parcial (I5) o `upsert_product_catalog` | La verdad es `inventory_balances`: es lo que valida la venta hoy |
| `stock_layers < stock_balances` | Ajuste positivo sin lote (I4), compra corregida (PC3), stock fijado desde el catálogo | Lote `reconciliation` por la diferencia, al costo de D41 |
| `stock_layers > stock_balances` | Ajuste negativo sin consumir FIFO (I4), `pay_sales_order` sin FIFO | Consumir lotes FIFO por la diferencia, con movimiento `reconciliation` |
| `stock_movements ≠ stock_balances` | Stock fijado sin movimiento | Movimiento `reconciliation` por la diferencia |
| Productos con stock fraccionado truncado | I2 | Revisar con el dueño; puede requerir un conteo físico |

**Antes de migrar, el dueño revisa y aprueba el informe.** Si las diferencias son grandes, se recomienda un **conteo físico** de los productos afectados y que la conciliación use ese valor.

### 5.2 Migración (T4)

1. Respaldo (`pnpm db:backup`).
2. Tabla `stock_reconciliation_log` con: producto, ubicación, valores anteriores (los cuatro), acción tomada y movimiento o lote creado. Permite auditar y revertir.
3. Por cada producto con diferencias, dentro de una transacción: movimientos `reconciliation` y ajustes de lotes hasta cumplir INV1 e INV2 contra el saldo de `inventory_balances`.
4. Verificación: la consulta de §5.1 devuelve **0 filas**.
5. `products.stock_on_hand` y `products.avg_cost` **dejan de leerse** en esta fase: la vista `product_catalog` y el POS leen el saldo. La columna **se elimina en la Fase 6 (T12)**, porque `create_sale` y `pay_sales_order` la siguen escribiendo hasta entonces.

---

## 6. Tareas en orden

### F5-T1 — Tests de caracterización de compras e inventario
- **Objetivo:** fijar el comportamiento actual (P1–P11, PC1–PC3, I1–I7) antes de reemplazarlo.
- **Archivos:** `tests/characterization/purchases.test.ts`, `tests/characterization/inventory-count.test.ts`, `supabase/seed.sql` (casos de prueba).
- **Pasos:**
  1. Por cada regla P, un test contra la RPC `create_purchase` en Supabase local: unidades con factor, promedio ponderado, lote, movimiento, total.
  2. Tests que **documenten los defectos** PC2, PC3, I2, I4 e I5. Se marcan como «comportamiento que se corrige a propósito» y se invierten en T8 y T9.
- **Terminado cuando:** los tests pasan contra la implementación actual y cada uno cita su regla (P1…, I1…).

### F5-T2 — Informe de conciliación
- **Objetivo:** conocer el descuadre real antes de migrar (§5.1).
- **Archivos:** `scripts/stock-reconciliation-report.mjs` (solo lectura), `docs/fases/anexos/fase-5-conciliacion.md`.
- **Pasos:** ejecutar la consulta sobre una copia local, clasificar por caso, estimar el impacto en valor (`diferencia × costo`) y presentarlo al dueño.
- **Terminado cuando:** el dueño aprobó el tratamiento de cada caso, o pidió un conteo físico.

### F5-T3 — Migración de esquema (aditiva)
- **Objetivo:** preparar las tablas sin romper las RPC heredadas.
- **Archivos:** `supabase/migrations/<ts>_inventory_domain_schema.sql`.
- **Pasos:**
  1. `location_id` (por defecto, la ubicación principal del negocio) en `inventory_balances`, `stock_cost_layers`, `stock_movements`, `purchases` e `inventory_count_sessions`. Índices `(tenant_id, product_id, location_id)`.
  2. Clave única de `inventory_balances` → `(tenant_id, product_id, location_id)`. **Ajuste mecánico mínimo** de `create_sale` y `pay_sales_order` (cláusulas `ON CONFLICT` y `WHERE` sobre la ubicación principal). Se cubre con los tests de caracterización de la Fase 6 (F6-T1) ejecutados antes y después.
  3. Ampliar el `CHECK` de `movement_type` (§3.1) y los valores de `stock_cost_layers.source`.
  4. Tabla `stock_reservations` (§3.1) con índices `(tenant_id, product_id, location_id) WHERE status = 'active'` y `(expires_at) WHERE status = 'active'`.
  5. Columna `reserved` en el saldo, o vista que la calcule (decidir en la validación según rendimiento).
  6. `purchases.client_request_id` + `UNIQUE (tenant_id, client_request_id)`; `purchases.location_id`; `purchases.status`.
  7. `inventory_count_items.system_qty_at_count` y `counted_at`; índice único parcial de sesión abierta por ubicación.
  8. Índices de fecha del plan (`purchases.purchase_date`, `stock_movements(movement_type, created_at)`).
  9. RLS por negocio en las tablas nuevas.
- **Terminado cuando:** las migraciones aplican limpias en CI y los tests de caracterización de compras y ventas siguen en verde.

### F5-T4 — Migración de datos a la fuente única
- **Objetivo:** cumplir INV1–INV3 en todos los productos (§5.2).
- **Archivos:** `supabase/migrations/<ts>_stock_reconciliation.sql`; tabla `stock_reconciliation_log`.
- **Pasos:** ensayo completo en local con copia de producción, luego en producción con respaldo previo.
- **Terminado cuando:** la consulta de §5.1 devuelve 0 filas en producción y el log registra cada corrección.

### F5-T5 — Dominio de inventario (puro)
- **Objetivo:** entidades y reglas de §3 sin infraestructura.
- **Archivos:** `layers/core/server/contexts/inventory/domain/{CostLayer,StockBalance,StockMovement,Reservation,InventoryCount}.ts`, `domain/fifo.ts` (consumo FIFO puro), `domain/averageCost.ts`, tests en `tests/unit/inventory/`.
- **Pasos:**
  1. `consumeFifo(layers, qty)` devuelve las asignaciones (lote, cantidad, costo) o falla por stock insuficiente.
  2. `applyInbound(balance, qty, unitCost)` con la fórmula P5.
  3. Reglas INV3–INV10 con `Money`/`Quantity`.
  4. Tests por invariante, más casos con cantidades fraccionadas y varios lotes.
- **Terminado cuando:** cobertura de 100% de ramas en `domain/` y ningún import fuera de `shared/domain`.

### F5-T6 — Adaptador de inventario y bloqueos
- **Objetivo:** persistir con Drizzle dentro del `UnitOfWork`, con el diseño de §4.
- **Archivos:** `contexts/inventory/infrastructure/drizzleInventoryRepository.ts`, `contexts/inventory/application/ports.ts`, `tests/integration/inventory/concurrency.test.ts`.
- **Pasos:** bloqueos ordenados; métodos `lockBalances(productIds, locationId)`, `lockLayers`, `appendMovement`, `appendLayer`, `updateLayerRemaining`, `saveBalance`; todos los tests de concurrencia de §4.
- **Terminado cuando:** los 5 tests de concurrencia pasan 20 veces seguidas sin fallos intermitentes.

### F5-T7 — `registerPurchase`
- **Objetivo:** reemplazar `create_purchase` con paridad total, más el permiso y la idempotencia.
- **Archivos:** `contexts/purchasing/{domain,application,infrastructure}/…`, `layers/core/server/api/purchases/create.post.ts` (con `defineApiHandler({ permission: 'purchases.register', body })`), esquema zod en `shared/`.
- **Pasos:**
  1. Caso de uso: valida, convierte unidades (Fase 3), crea compra y líneas, llama a `receiveIntoLayer`, `recordStockMovement` y `applyInbound`, y publica `PurchaseRegistered`. Todo en un `UnitOfWork`.
  2. Interruptor `ENGINE_REGISTER_PURCHASE=db|domain`.
  3. Los tests P2–P10 corren contra ambos motores y dan el mismo resultado.
  4. Cambios intencionales: P1 pasa a exigir permiso; P11 admite fecha de compra opcional (no futura).
- **Terminado cuando:** paridad P2–P10 en verde con `domain`; en producción con `domain` durante al menos 2 semanas sin incidentes.

### F5-T8 — `correctPurchase`
- **Objetivo:** corregir compras sin descuadrar nada (reemplaza PC1–PC3).
- **Archivos:** `contexts/purchasing/application/correctPurchase.ts`, `api/purchases/items.patch.ts`.
- **Pasos:**
  1. Regla INV11 (pendiente de confirmar, DP5-1): solo se corrigen líneas cuyo lote **no fue consumido** (`qtyRemaining = qtyIn`).
  2. La corrección ajusta, en la misma transacción: línea (campos UoM y base), lote, saldo, costo promedio (se recalcula revirtiendo la entrada y aplicando la nueva) y movimiento `purchase_correction` por la diferencia. Publica `PurchaseCorrected`.
  3. Si el lote ya se consumió, el error explica la alternativa: un ajuste de inventario, o una devolución a proveedor cuando exista.
  4. Invertir los tests de defecto PC2 y PC3 de T1.
- **Terminado cuando:** corregir una compra mantiene INV1, INV2 e INV10 (test de integración).

### F5-T9 — Conteos de inventario
- **Objetivo:** `startCount`, `applyCount` y `closeCount` atómicos, con decimales y FIFO.
- **Archivos:** `contexts/inventory/application/{startCount,applyCount,closeCount}.ts`, `api/inventory/{start,apply,close}.post.ts`.
- **Pasos:**
  1. `startCount` por ubicación (índice único parcial).
  2. Al contar una línea se guarda `systemQtyAtCount` (§4.4).
  3. `applyCount`: delta relativo (DP5-2). Si el delta es negativo, `consumeFifo` + `adjustment_out`. Si es positivo, lote nuevo con el **último costo de compra** del producto en esa ubicación, o el promedio si nunca se compró (D41), + `adjustment_in`.
  4. `Quantity` con decimales (corrige I2).
  5. `nonSellable` (DP5-3): propuesta, se registra como salida `adjustment_out` con motivo «no vendible» si el dueño lo confirma.
  6. Publica `StockAdjusted` y, si corresponde, `StockLow`.
  7. Invertir los tests de defecto I2, I4 e I5.
- **Terminado cuando:** un conteo aplicado mantiene INV1–INV3 con cantidades fraccionadas, y el test de «venta entre el conteo y la aplicación» da el resultado de §4.4.

### F5-T10 — Reservas persistentes
- **Objetivo:** reemplazar las reservas en memoria del agente (`agent/app/reservations.ts`, usadas en `salesAgent.ts`, `llmSalesSelector.ts` y `utils/agent.ts`).
- **Archivos:** `contexts/inventory/application/{reserveStock,releaseReservation,expireReservations}.ts`; migración con un job de `pg_cron` cada minuto que llama a la expiración (D23).
- **Pasos:**
  1. `reserveStock` valida `available` bajo bloqueo (INV4).
  2. `releaseReservation` y `consumeReservation` (este último lo usa la venta en la Fase 6).
  3. La expiración publica `ReservationExpired`.
  4. `getStock` devuelve `onHand`, `reserved` y `available`.
  5. **El agente adopta las reservas persistentes en la Fase 6 (F6-T10)**, junto con `registerSale`. Aquí solo se construye y prueba la capacidad.
- **Terminado cuando:** test de carrera de reservas en verde; una reserva vencida libera stock en menos de 2 minutos.

### F5-T11 — Transferencias entre ubicaciones
- **Objetivo:** capacidad del núcleo (D7), sin interfaz visible mientras cada negocio tenga una sola ubicación.
- **Archivos:** `contexts/inventory/application/transferStock.ts`, `api/inventory/transfer.post.ts`.
- **Pasos:** en una transacción: `consumeFifo` en origen + `transfer_out`; en destino, un lote **por cada asignación** (conserva el costo exacto de cada lote) + `transfer_in`. Recalcula el promedio en destino. Publica `StockTransferred`.
- **Terminado cuando:** test de integración con dos ubicaciones: INV1 e INV2 se cumplen en ambas y el valor total del inventario no cambia.

### F5-T12 — Evento `StockLow`
- **Objetivo:** aviso de stock bajo para otros módulos (notificaciones, reposición).
- **Archivos:** `contexts/inventory/domain/stockLow.ts`, emisión dentro de las salidas.
- **Terminado cuando:** una salida que cruza `minStock` deja exactamente un evento en el outbox, y una que ya estaba por debajo no lo repite.

### F5-T13 — El catálogo deja de escribir stock
- **Objetivo:** cumplir INV7. Coordinado con la Fase 3: si `saveProduct` ya no escribe stock, aquí solo se verifica.
- **Archivos:** `contexts/catalog/application/saveProduct.ts`; la vista `product_catalog` (o la vista liviana de la Fase 7) lee el saldo.
- **Pasos:**
  1. Quitar `p_stock_on_hand` y `p_avg_cost` del guardado de producto.
  2. El stock inicial de un producto nuevo se registra como **ajuste de entrada** (lote + movimiento), con el costo indicado.
- **Terminado cuando:** buscar escrituras a `stock_on_hand` fuera de `contexts/inventory` y de las RPC heredadas de venta no da resultados.

### F5-T14 — Retiro de lo reemplazado
- **Objetivo:** que no quede lógica de compras o inventario fuera del dominio.
- **Pasos:**
  1. Tras el periodo estable, quitar el interruptor y eliminar la RPC `create_purchase`.
  2. Eliminar la función huérfana `purchase_items_sync_base_fields`.
  3. Eliminar `server/modules/purchases/**` y `server/modules/inventory/**` (los reemplazan los contextos).
  4. Job diario de `pg_cron` que ejecuta la consulta de §5.1 y, si devuelve filas, registra el problema (Sentry vía outbox o tabla de alertas).
- **Terminado cuando:** `create_purchase` no existe en la BD y el job de invariantes lleva 7 días sin alertas.

### F5-T15 — Cierre de fase
- **Pasos:** completar el «Registro de cambios»; actualizar `arquitectura.md` si hubo decisiones nuevas; pasar el estado a **Terminada**; validar la Fase 6.

---

## 7. Cómo verificar

```bash
pnpm vitest run tests/unit/inventory tests/unit/purchasing
```

```bash
pnpm vitest run tests/characterization/purchases.test.ts tests/characterization/inventory-count.test.ts
```

```bash
for i in $(seq 20); do pnpm vitest run tests/integration/inventory || break; done
```

- La consulta de §5.1 devuelve 0 filas (local, staging y producción).
- Prueba manual en staging (Playwright): registrar compra → vender → contar con diferencia → corregir compra no consumida → transferir. El valor del inventario cuadra en cada paso.

---

## 8. Cómo volver atrás

- **Casos de uso:** `ENGINE_REGISTER_PURCHASE=db` vuelve a la RPC al instante, mientras no se haya ejecutado T14.
- **Esquema:** las migraciones de T3 son aditivas. Las RPC heredadas siguen funcionando con la ubicación por defecto.
- **Datos:** `stock_reconciliation_log` permite revertir cada corrección; además, el respaldo previo (D44).
- **Conteos y correcciones:** no tienen motor heredado al que volver. Por eso T8 y T9 se publican solo con sus tests de integración en verde y primero en staging.

---

## 9. Riesgos

| Riesgo | Mitigación |
|---|---|
| La conciliación revela diferencias grandes de stock o valor | Informe aprobado por el dueño antes de migrar; conteo físico de los productos afectados |
| Cambiar la clave de `inventory_balances` rompe `create_sale` o `pay_sales_order` | Ajuste mecánico mínimo + tests de caracterización de venta antes y después (F6-T1 se adelanta a esta fase si hace falta) |
| Deadlocks con varios productos | Orden fijo de bloqueos + test específico |
| Cambio de comportamiento del conteo (delta relativo) confunde al usuario | Mostrar en pantalla «sistema al contar», «contado» y «diferencia aplicada»; confirmar DP5-2 |
| Las cantidades fraccionadas truncadas hoy ya alteraron el stock real | Detectarlas en el informe de conciliación; conteo físico |
| Coexistencia de la RPC `create_sale` (heredada) con el dominio de inventario | Ambos usan los mismos bloqueos (`inventory_balances FOR UPDATE`) y las mismas tablas; el job de invariantes detecta descuadres |

---

## 10. Decisiones pendientes para la validación de inicio

| # | Pregunta | Propuesta |
|---|---|---|
| DP5-1 · **Resuelta: D58** | ¿Se puede corregir una compra cuyos lotes ya se consumieron? | **No.** Solo líneas no consumidas; para lo demás, ajuste o devolución a proveedor. Corregir costos ya consumidos cambiaría la rentabilidad de ventas pasadas |
| DP5-2 · **Resuelta: D59** | ¿El conteo aplica un delta relativo al stock del momento del conteo, o fija el valor absoluto como hoy? | **Delta relativo** (§4.4) |
| DP5-3 | ¿Qué hacer con `non_sellable` del conteo? | Salida `adjustment_out` con motivo «no vendible» |
| DP5-4 | ¿«Devolución a proveedor» entra en esta fase? | No; documentarla como caso de uso futuro de `purchasing` |

---

## 11. Registro de cambios

| Fecha | Cambio | Motivo |
|---|---|---|
| 2026-11-18 | Consolidación: DP5-1 y DP5-2 resueltas (D58, D59). **F6-T1 (tests de caracterización de ventas y pedidos) se ejecuta al inicio de esta fase**, antes de cambiar la clave de `inventory_balances`. `create_purchase` ya exige dueño o encargado desde F0-T9. | Decisiones del usuario y orden entre fases |
| 2026-11-18 | Documento inicial | Plan de fases |
