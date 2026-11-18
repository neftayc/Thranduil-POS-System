# Fase 6 — Ventas y caja

> **Estado:** Por validar al iniciar · **Detalle:** por caso de uso + modelo de dominio
> **Arquitectura:**
> - D8 (caja), D10 (documento de venta), D12 (devoluciones y anulaciones), D18–D19 (agente), D26–D28 y D44 (requisitos del segundo negocio)
> - D38 (decimales), D39 (stock negativo bloqueado), D40 (costo de devolución), D42 (correlativos)
> - §5, §6.3, §8.3, §10.1, §12
>
> Las referencias `archivo:línea` corresponden al repositorio al 2026-11-18 y se revalidan al iniciar la fase.

---

## 1. Objetivo y alcance

**Objetivo.** Reemplazar el corazón transaccional (`create_sale`, `create_sales_order`, `pay_sales_order`) por casos de uso del dominio, y agregar caja, anulación y devolución. Al terminar:
- **no queda lógica de negocio en PL/pgSQL**;
- toda venta tiene tipo, serie y número;
- toda venta consume FIFO correctamente;
- el agente registra a través de `registerSale`.

**Entra:**
- documento de venta con líneas de bienes y servicios;
- pagos;
- sesión de caja (abrir, cerrar, movimientos, arqueo);
- pedidos (crear, cobrar, cancelar) con reservas;
- anulación y devolución;
- correlativos;
- cambio del agente a `registerSale` con reservas persistentes;
- eliminación del modo `localStorage` de ventas en espera;
- eventos del outbox;
- retiro de las RPC de venta y de `products.stock_on_hand`;
- **verificación de la puerta del segundo negocio**.

**No entra:**
- la resolución de precio (Fase 4: aquí se **usa** `resolvePrice`);
- el envío a SUNAT (módulo transversal futuro; aquí solo se prepara el documento, D10);
- el crédito o fiado (módulo transversal, D11);
- el pulido visual del POS (Fase 9). Aquí se hace la interfaz **mínima** de caja y devoluciones.

### 1.1 Comportamiento actual de `create_sale` (verificado, `baseline.sql:243`)

Estas reglas son la base de los tests de caracterización (T1). Cada test cita su número.

| # | Regla actual |
|---|---|
| S1 | Exige `auth.uid()`; `p_items` debe ser un arreglo |
| S2 | Método de pago: `resolve_payment_method_code(p_payment_method)` (acepta código o etiqueta normalizada de un método activo). Si no lo reconoce, **usa `efectivo` sin avisar**. El trigger `sales_payment_method_guard` repite esa normalización en cada `INSERT` o `UPDATE` de `sales` |
| S3 | Rol: `user_role()`, con `cashier` por defecto. Descuento manual permitido solo a `owner` y `manager` |
| S4 | `p_sold_by` (opcional): debe ser un usuario activo (no borrado ni bloqueado en `auth.users`). Si es distinto de quien registra, exige `owner` o `manager`. Sin `p_sold_by`, el vendedor es quien registra |
| S5 | `p_approved_by` (opcional): debe ser igual a `auth.uid()` y el rol debe ser `owner` o `manager`. **No hay ninguna operación que exija aprobación**: solo se registra |
| S6 | Por ítem: `qty > 0`; `price_unit` opcional y `>= 0`; el producto existe; la unidad se resuelve igual que en la compra (P3 de la Fase 5) |
| S7 | Precio automático: `resolve_sale_item_pricing(producto, unidad, qty, cliente, now())` devuelve `factor`, `qty_base`, `price_uom` y `source` |
| S8 | Hay ajuste manual si existe `manual_discount_pct > 0`, `manual_discount_amount > 0`, o `|price_unit − automático| > 0.0001`. En ese caso exige rol S3 y un **motivo obligatorio** |
| S9 | Orden de aplicación: primero `% de descuento`, luego `monto de descuento`, y por último, si hay precio explícito distinto, **el precio explícito reemplaza todo**. Se redondea a 4 decimales; si el resultado es negativo, error |
| S10 | `price_unit` (base) = precio final / factor, a 4 decimales |
| S11 | Crea la fila de saldo si no existe (copiando stock y promedio de `products`) y la bloquea con `FOR UPDATE` |
| S12 | Si `stock < qty_base` → «Stock insuficiente para \<producto\>» (D39) |
| S13 | Consume lotes FIFO por `layer_date` y luego `fifo_order`, bloqueándolos con `FOR UPDATE`. Guarda cada asignación en `sale_cost_allocations` |
| S14 | **Lote de respaldo:** si los lotes no alcanzan (pero el saldo sí), crea un lote `auto-balance` con `qty_in` = faltante, `qty_remaining = 0` y costo = promedio. Es un síntoma de FIFO descuadrado; tras la Fase 5 no debería ocurrir |
| S15 | Costo unitario de la venta = costo FIFO total / qty_base (4 decimales) |
| S16 | Resta el stock en `inventory_balances` **y** en `products`; el promedio no cambia |
| S17 | `sale_items`: guarda unidad, factor, precio de la unidad y base, precio automático, origen y detalle del precio, descuentos y motivo; `total = qty × precio final` **sin redondeo explícito** (la columna `numeric(12,2)` redondea al guardar) |
| S18 | Movimiento `sale` con `−qty_base` al costo unitario FIFO |
| S19 | `sales.total` = suma de los totales **sin redondear** de las líneas, redondeada al guardar. **Puede diferir en céntimos de la suma de las líneas guardadas** |
| S20 | La venta no tiene número, serie, caja, ubicación ni estado |

### 1.2 Comportamiento actual de pedidos (ventas en espera)

| # | Regla actual |
|---|---|
| O1 | `create_sales_order` (`baseline.sql:594`): calcula precio con `resolve_sale_item_pricing`, pero **acepta `price_unit` del cliente sin validar rol ni motivo**. Cualquier cajero puede guardar un pedido con el precio que quiera |
| O2 | No valida stock ni reserva nada |
| O3 | El total de línea se redondea a 2 decimales (distinto de S17) |
| O4 | Código `PED-AAAAMMDD-HHMISS-XXXX` (4 hexadecimales aleatorios; `UNIQUE`). Una colisión en el mismo segundo hace fallar la creación. Un error con `gen_random_bytes` (pgcrypto en el esquema `extensions`) se corrigió el 2026-11-18 (`20261118121259_arreglar_codigo_pedido.sql`) |
| O5 | `pay_sales_order` (`baseline.sql:925`): bloquea el pedido abierto, crea la venta con los precios **congelados** del pedido y valida el stock |
| O6 | **No consume FIFO ni crea `sale_cost_allocations`**: el movimiento usa el costo promedio. Cada pedido cobrado deja el FIFO descuadrado (los lotes conservan cantidad que ya no existe) |
| O7 | La venta del pedido no guarda `sold_by` (queda NULL) y registra el motivo «Cobro de pedido» |
| O8 | Cancelar un pedido (`api/sales/held/[id]/delete`) **borra la fila** (`DELETE … WHERE status = 'open'`), sin historial |
| O9 | `pages/sales.vue` (`:264-280`, `:1135-1190`, `:2227`): si una llamada de pedidos falla con un texto que «parece» que falta el backend (`isOrdersBackendMissing`, que incluye cualquier «function … does not exist»), **guarda las ventas en espera en `localStorage` sin avisar**. Con el error de O4, esto pudo dejar ventas en espera solo en el navegador de algún equipo |

### 1.3 Agente de ventas (`server/modules/agent/infra/supabaseSaleExecutor.ts`)

- Llama a `create_sale` con el **token del propio vendedor** (registra `auth.uid()` = vendedor) y un tiempo límite de 20 s.
- Un error con código es un rechazo definitivo; un error sin código (red o tiempo agotado) es un resultado **indeterminado** que nunca se reintenta.
- Envía `price_unit` y, si difiere del precio de lista, `manual_discount_reason` (solo dueño o encargado).
- Las reservas de las operaciones «por confirmar» viven solo en memoria (`agent/app/reservations.ts`).

---

## 2. Requisitos previos

- [ ] Fases 2, 3, 4 y 5 terminadas. Esta fase necesita:
  - `resolvePrice` en el dominio (Fase 4);
  - `consumeFifo`, `recordStockMovement`, `reserveStock` y `consumeReservation` (Fase 5);
  - stock con una sola fuente y conciliado (Fase 5, T4).
- [ ] Interfaz de caja mínima acordada (pantallas de abrir y cerrar caja).
- [ ] Decisiones pendientes de §10 resueltas en la validación de inicio.
- [ ] Respaldo de producción antes de cada migración (D44).

---

## 3. Modelo de dominio

### 3.1 Entidades

| Entidad (código) | Campos clave | Notas |
|---|---|---|
| `SaleDocument` | `id`, `tenantId`, `locationId`, `docType`, `series`, `number`, `status` (`issued`, `voided`), `issuedAt`, `customerId?`, `soldBy`, `createdBy`, `approvedBy?`, `cashSessionId?`, `source` (`pos`, `order`, `agent`, `quote`, `work_order`…), `sourceId?`, `clientRequestId`, `currency`, `lines[]`, `payments[]`, `subtotal`, `taxTotal`, `total` | Inmutable una vez emitido: se cambia solo con anulación o devolución |
| `SaleLine` | `itemKind` (`stock_item`, `service`, `kit`), `productId`, `unitName`, `qtyUom`, `factorToBase`, `qtyBase`, `autoUnitPrice`, `finalUnitPrice`, `pricingSource`, `pricingDetail`, `manualDiscountPct`, `manualDiscountAmount`, `manualReason?`, `taxRate`, `taxAmount`, `lineTotal`, `costAllocations[]` | `costAllocations` solo para `stock_item` (y los componentes de un `kit`) |
| `Payment` | `method` (código del catálogo), `amount`, `received?`, `change?` | Varias formas de pago por venta; el POS inicial usa una |
| `DocumentSeries` | `tenantId`, `docType`, `series`, `nextNumber`, `locationId?` | D42: número sin huecos, con bloqueo de fila |
| `CashSession` | `id`, `locationId`, `register` (nombre de la caja), `openedBy`, `openedAt`, `openingAmount`, `status` (`open`, `closed`), `closedBy?`, `closedAt?`, `countedAmount?`, `expectedAmount?`, `difference?`, `movements[]` | D8 |
| `CashMovement` | `type` (`sale_cash`, `refund_cash`, `cash_in`, `cash_out`), `amount`, `reason?`, `refType`, `refId` | Los manuales (`cash_in`, `cash_out`) exigen motivo |
| `SalesOrder` (pedido) | `id`, `code`, `status` (`open`, `paid`, `cancelled`), `customerId?`, `lines[]` (precios congelados), `reservationIds[]`, `expiresAt?`, `paidSaleId?`, `cancelledBy?`, `cancelReason?` | Ya no se borra: se cancela |
| `SaleReturn` | `id`, `originalSaleId`, `docType` (nota de crédito interna), `series`, `number`, `lines[]` (`saleLineId`, `qty`), `refund` (método, monto), `reason`, `createdBy` | D12, D40 |
| `SaleVoid` | Es un estado del `SaleDocument`, no una entidad: `voidedAt`, `voidedBy`, `voidReason` | D12 |

**Tipos de documento iniciales** (`docType`), mientras no exista el módulo SUNAT:
- `ticket`: nota de venta interna, serie `T001`;
- `return_note`: nota de devolución interna, serie `D001`.

Cuando llegue el módulo de facturación electrónica se agregan `boleta`, `factura` y `credit_note` con sus series. El modelo no cambia.

### 3.2 Reglas (invariantes)

| # | Invariante |
|---|---|
| SV1 | `lineTotal = round2(qtyUom × finalUnitPrice)`; `taxAmount` se calcula **por línea** y se redondea a 2 decimales (D38); `total = Σ lineTotal`. **Cambio intencional** respecto a S19: el total siempre es la suma exacta de las líneas guardadas |
| SV2 | Precio o descuento manual ⇒ permiso `sales.manual_discount` + motivo (S8). Aplica también a los **pedidos** (corrige O1) |
| SV3 | Orden de aplicación de descuentos: igual que S9 (porcentaje, luego monto; el precio explícito reemplaza todo); `finalUnitPrice >= 0` |
| SV4 | Las líneas `stock_item` consumen stock con `consumeFifo` (D39). Las `service` no tocan inventario. Las `kit` consumen sus componentes |
| SV5 | `(tenantId, docType, series, number)` es único y consecutivo, sin huecos (D42) |
| SV6 | `Σ payments.amount = total`; solo en efectivo `received >= amount` y `change = received − amount` |
| SV7 | `soldBy` es un miembro activo del negocio; si es distinto de `createdBy`, exige `sales.on_behalf` (S4) |
| SV8 | `approvedBy`, si existe, es igual a `createdBy` y exige el permiso de aprobación (ver DP6-4) |
| SV9 | Un pago en efectivo exige una caja abierta de quien registra en esa ubicación, y crea un `CashMovement` `sale_cash` (ver DP6-1 para el agente) |
| SV10 | Un documento emitido no se edita. Las correcciones se hacen con anulación o devolución |
| SV11 | Devolución: `qty` devuelta por línea ≤ vendida − ya devuelta. Los bienes vuelven al stock con el **costo de las asignaciones originales** (D40), tomando primero las asignaciones más recientes de esa línea. Cada asignación devuelta crea un lote `return` con su costo |
| SV12 | La anulación completa exige `sales.void` y caja original abierta. Tras una devolución parcial, aplicar la regla que el dueño valide en DP6-9 antes de implementar F6-T9. En todos los casos, cantidades y reembolsos acumulados tienen como tope la venta original. |
| SV13 | Una caja abierta por usuario y ubicación. Al cerrarla: `expectedAmount = apertura + Σ efectivo entrante − Σ efectivo saliente`, y `difference = contado − esperado` |
| SV14 | Idempotencia: `(tenantId, clientRequestId)` es único. Repetir la petición devuelve la venta existente, sin registrar otra |
| SV15 | Un pedido cobrado consume FIFO como cualquier venta (corrige O6), guarda `soldBy` (corrige O7) y consume sus reservas |
| SV16 | Método de pago desconocido ⇒ **error**, no `efectivo` silencioso (cambio intencional respecto a S2; ver DP6-3) |

### 3.3 Eventos (outbox, §8.3)

| Evento (código) | Cuándo | Consumidores previstos |
|---|---|---|
| `SaleRegistered` (VentaRegistrada) | Al emitir una venta | Crédito (D11), facturación PE, agente |
| `SaleVoided` (VentaAnulada) | Al anular | Facturación PE (comunicación de baja), crédito |
| `ReturnRegistered` (DevolucionRegistrada) | Al registrar una devolución | Facturación PE (nota de crédito), crédito |
| `CashSessionClosed` (CajaCerrada) | Al cerrar caja | Reportes, avisos al dueño |
| `OrderCancelled` | Al cancelar un pedido | — |
| `StockLow` | Lo emite el inventario (Fase 5) durante la venta | Notificaciones |

### 3.4 Casos de uso y qué reemplazan

| Caso de uso (código) | Reemplaza | Permiso (§10.1) |
|---|---|---|
| `registerSale` | RPC `create_sale`; trigger `sales_payment_method_guard`; `resolve_payment_method_code` (pasa al dominio) | `sales.register` (+ `sales.manual_discount` y `sales.on_behalf` según la venta) |
| `createOrder` | RPC `create_sales_order` y `generate_sales_order_code` | `sales.register` |
| `payOrder` | RPC `pay_sales_order` | `sales.register` |
| `cancelOrder` | `DELETE` en `api/sales/held/[id]/delete` | `sales.register` (su propio pedido) / `sales.void` (cualquiera) |
| `voidSale` | Nuevo | `sales.void` |
| `registerReturn` | Nuevo | `returns.register` |
| `openCashSession` / `closeCashSession` / `recordCashMovement` | Nuevo | `cash.operate` |
| `getCashSummary` (consulta) | Nuevo | `cash.operate` (la propia) / `cash.view_all` |
| `allocateDocumentNumber` (interno) | Nuevo (D42) | — |

---

## 4. Diseño transaccional

`registerSale` corre en **un** `UnitOfWork`, en este orden:
1. Verificar sesión, negocio, permiso y acceso al documento. Identificar el cobro lógico con `(tenantId, clientRequestId)` y asociarlo a su origen y contenido. Repetirlo devuelve el resultado ya confirmado; reutilizar la clave para otra operación devuelve conflicto. La restricción única y el manejo de carreras cubren peticiones simultáneas.
2. Validar permisos, vendedor y caja abierta (SV7–SV9).
3. En venta directa, `resolvePrice` calcula el precio y los ajustes autorizados. En cobro de pedido, bloquear el pedido abierto y usar su instantánea persistida de líneas, cantidades, factores, descuentos e impuestos. El backend carga el precio pactado; un precio recibido del navegador no lo sustituye.
4. Bloquear saldos ordenados por producto (Fase 5, §4) y consumir reservas propias si hay.
5. Consumir FIFO y registrar movimientos por cada `stock_item` y componente físico de un kit. Conservar el desglose vendido y sus asignaciones para devoluciones posteriores.
6. `allocateDocumentNumber`: `SELECT … FOR UPDATE` en `document_series`. Se toma **al final**, para mantener el bloqueo de la serie el menor tiempo posible.
7. Guardar documento, líneas, asignaciones, pagos y movimiento de caja. Si procede de un pedido, verificar el consumo de sus reservas del paso 4, marcarlo pagado y enlazar una única venta dentro de la misma transacción, incluso con dos claves de petición diferentes.
8. Escribir `SaleRegistered` en el outbox.

Si cualquier paso falla, no queda nada (ni número consumido, ni stock, ni caja).

**Tests de concurrencia:**
- 50 ventas simultáneas en la misma serie: números del 1 al 50, sin huecos ni repetidos;
- ventas simultáneas del último stock (heredado de la Fase 5);
- la misma `clientRequestId` enviada dos veces a la vez: una sola venta;
- cerrar la caja mientras se registra una venta en efectivo: la venta queda dentro o fuera del cierre, nunca a medias.

---

## 5. Tareas en orden

### F6-T1 — Tests de caracterización de ventas y pedidos
- **Objetivo:** fijar S1–S20 y O1–O8 antes de reemplazarlos. **Se puede adelantar a la Fase 5**, porque F5-T3 toca `create_sale`.
- **Archivos:** `tests/characterization/create-sale.test.ts`, `tests/characterization/sales-orders.test.ts`, casos en `supabase/seed.sql`.
- **Pasos:**
  1. Una prueba por regla.
  2. Combinaciones de descuento de S9: porcentaje + monto, porcentaje + precio explícito, tolerancia 0.0001.
  3. Roles en S3, S4 y S5.
  4. Varios lotes y lote de respaldo en S14.
  5. Redondeo de S17 y S19, con un caso que demuestre la diferencia de céntimos.
  6. Métodos de pago por código, por etiqueta y desconocido.
  7. Registrar los cambios intencionales S19, S2, O1, O7 y O8 junto a la prueba que adopta la regla nueva. F5-T3 ya corrigió O6. Ambos motores deben conservar ese consumo FIFO.
- **Terminado cuando:** pasan contra las RPC actuales y cada test cita su regla.

### F6-T2 — Esquema de ventas, caja y series
- **Archivos:** `supabase/migrations/<ts>_sales_domain_schema.sql`.
- **Pasos:**
  1. `document_series` (D42) con una fila por negocio: `ticket/T001` y `return_note/D001`.
  2. En `sales`: `location_id`, `doc_type`, `series`, `number`, `status`, `issued_at`, `cash_session_id`, `source`, `source_id`, `client_request_id` + `UNIQUE (tenant_id, client_request_id)`, `subtotal`, `tax_total`, `voided_at`, `voided_by`, `void_reason`, y `UNIQUE (tenant_id, doc_type, series, number)`.
  3. En `sale_items`: `item_kind`, `tax_rate` y `tax_amount`.
  4. Tablas nuevas: `sale_payments`, `cash_sessions` (índice único parcial: una abierta por usuario y ubicación), `cash_movements`, `sale_returns`, `sale_return_items`.
  5. En `sales_orders`: `expires_at`, `cancelled_at`, `cancelled_by`, `cancel_reason`, `sold_by`; vínculo con `stock_reservations`.
  6. RLS por negocio en todas las tablas nuevas.
  7. **Relleno de datos históricos:**
     - ventas existentes → `doc_type = 'ticket'`, serie `T001`, `number` correlativo por `sale_date, created_at` y `status = 'issued'`;
     - un `sale_payment` por venta con `payment_method` y `total`;
     - `document_series.next_number` = máximo + 1.
- **Terminado cuando:** migración limpia en CI y en un ensayo con copia local; los tests de T1 siguen en verde (las RPC siguen funcionando con valores por defecto).

### F6-T3 — Dominio de ventas (puro)
- **Archivos:** `layers/core/server/contexts/sales/domain/{SaleDocument,SaleLine,Payment,CashSession,SalesOrder,SaleReturn,DocumentSeries}.ts`, `domain/totals.ts`, `domain/manualAdjustments.ts`, `tests/unit/sales/`.
- **Pasos:**
  1. SV1 (totales e impuesto por línea con `Money`), SV2–SV3 (ajustes manuales), SV6 (pagos), SV11–SV13 (devolución, anulación, caja).
  2. Pruebas con los mismos valores de los tests de caracterización, para comprobar la paridad del cálculo.
- **Terminado cuando:** 100% de ramas en `domain/` y paridad de precios finales con S9–S10 en todos los casos de T1.

### F6-T4 — Correlativos
- **Archivos:** `contexts/sales/infrastructure/drizzleDocumentSeries.ts`, `tests/integration/sales/document-series.test.ts`.
- **Terminado cuando:** el test de 50 ventas simultáneas da números del 1 al 50, sin huecos, 20 veces seguidas.

### F6-T5 — `registerSale`
- **Objetivo:** reemplazar `create_sale` con paridad, más caja, número e idempotencia.
- **Archivos:**
  - `contexts/sales/application/registerSale.ts`;
  - `contexts/sales/infrastructure/drizzleSalesRepository.ts`;
  - `layers/core/server/api/sales/create-sale.post.ts` (`defineApiHandler({ permission: 'sales.register', body })`);
  - esquema zod en `shared/`.
- **Pasos:**
  1. Implementar §4.
  2. Interruptor `ENGINE_REGISTER_SALE=db|domain`.
  3. T1 corre contra los dos motores. Las diferencias permitidas son **solo** los cambios intencionales (S2→SV16, S19→SV1, S20) y deben estar listadas en el test.
  4. El POS genera `clientRequestId` al iniciar el cobro y lo conserva hasta obtener un resultado definitivo, incluso tras perder la respuesta o recargar la pantalla. El alcance incluye usuario, negocio y ubicación del borrador.
- **Terminado cuando:** la paridad de venta directa está en verde en staging con una caja de prueba abierta y se mantienen INV1 e INV2. La activación en la tienda requiere entregar F6-T6 y F6-T7 y completar una semana de pruebas en staging. Observar dos semanas estables en producción antes de retirar el motor anterior en F6-T12.

### F6-T6 — Caja
- **Archivos:** `contexts/sales/application/{openCashSession,closeCashSession,recordCashMovement,getCashSummary}.ts`, rutas en `api/cash/*`, interfaz mínima en el POS (abrir con monto inicial, cerrar con monto contado, ver la diferencia).
- **Pasos:**
  1. SV9, SV13.
  2. Publicar `CashSessionClosed`.
  3. Al activar la caja, la primera venta en efectivo del día obliga a abrirla.
  4. **Se activa por negocio** con `tenant_settings.cash_sessions_required` (por defecto `true`), para no bloquear la operación mientras el personal se acostumbra.
- **Terminado cuando:** un cierre con ventas en efectivo, devoluciones y movimientos manuales da el esperado correcto (test de integración).

### F6-T7 — Pedidos: crear, cobrar, cancelar
- **Archivos:** `contexts/sales/application/{createOrder,payOrder,cancelOrder}.ts`, `api/sales/hold.post.ts`, `api/sales/held/[id]/pay.post.ts`, `api/sales/held/[id]/cancel.post.ts` (reemplaza `delete.post.ts`).
- **Pasos:**
  1. `createOrder`: precios con `resolvePrice`; el precio manual exige permiso (corrige O1); reserva el stock de cada línea `stock_item` (`reserveStock`, Fase 5) con vencimiento configurable (DP6-5). Guardar la instantánea comercial completa, incluido el desglose de componentes reservados para kits.
  2. `payOrder`: en la misma transacción delega en `registerSale` con `source = 'order'`, los precios congelados del pedido y el consumo de sus reservas (conserva la corrección FIFO de F5 y corrige O7).
  3. `cancelOrder`: cambia el estado a `cancelled` con motivo y libera las reservas (corrige O8).
  4. El código del pedido pasa a ser una serie `order/P001` (D42), o se mantiene el formato actual (DP6-6).
- **Terminado cuando:** se preserva la corrección de O6 entregada en F5, se verifican O1/O7/O8 y el stock reservado queda protegido. Un pedido pactado a S/ 10 se cobra a S/ 10 aunque el precio vigente sea S/ 12; dos cobros concurrentes del mismo pedido producen una sola venta.

### F6-T8 — Eliminar el modo `localStorage` de ventas en espera
- **Objetivo:** que las ventas en espera solo vivan en la BD (corrige O9).
- **Archivos:** `pages/sales.vue` (o su componente extraído en la Fase 9).
- **Pasos:**
  1. **Versión de transición:** al cargar el POS, si hay ventas en espera en `localStorage` (`papeleria_pos_hold_sales_v1`), ofrecer subirlas como pedidos con `createOrder` y luego borrarlas del navegador.
  2. Tras un periodo prudente (todos los equipos de la tienda abrieron el POS), quitar `isOrdersBackendMissing`, la lectura y la escritura locales.
  3. Los errores del backend se muestran; nunca se usa otro almacenamiento en silencio.
- **Terminado cuando:** buscar `HOLD_STORAGE_KEY` e `isOrdersBackendMissing` no da resultados.

### F6-T9 — Anulación y devolución
- **Archivos:** `contexts/sales/application/{voidSale,registerReturn}.ts`, `api/sales/[id]/void.post.ts`, `api/sales/[id]/return.post.ts`, interfaz mínima en el historial de ventas.
- **Pasos:**
  1. SV11 y SV12.
  2. La devolución usa la serie `return_note`; el reingreso al stock crea lotes `return` con el costo original (D40); el reembolso en efectivo crea un `refund_cash` en la caja abierta de quien devuelve.
  3. Eventos `SaleVoided` y `ReturnRegistered`.
- **Terminado cuando:** probar anulación íntegra de una venta con caja abierta y, en otra venta, devolución parcial seguida de la resolución aprobada en DP6-9. Verificar stock, asignaciones FIFO, reembolso y margen sin doble reversión.

### F6-T10 — El agente pasa a `registerSale`
- **Objetivo:** D18, §12. El agente deja de llamar a la RPC.
- **Archivos:**
  - `server/modules/agent/infra/supabaseSaleExecutor.ts`, que se reemplaza por `layers/modules/agent/server/infrastructure/domainSaleExecutor.ts` (o queda en su ubicación actual hasta la Fase 8; ver DP6-7);
  - `server/utils/agent.ts`;
  - `agent/app/reservations.ts`.
- **Pasos:**
  1. El ejecutor llama a `registerSale` **en el mismo proceso** con:
     - `soldBy` = vendedor identificado;
     - `source = 'agent'`;
     - `clientRequestId` = id de la operación del agente.
  2. Con la idempotencia, el caso «indeterminado» (tiempo agotado) **ya se puede reintentar sin duplicar**. Se actualiza `SaleNotCommittedError` y la lógica asociada.
  3. Las operaciones «por confirmar» usan `reserveStock` con vencimiento igual al de la operación; al confirmar, `registerSale` consume la reserva; al vencer o cancelar, se libera.
  4. Se elimina `reservedFromOperations` y las respuestas de catálogo leen `available` de `getStock`.
  5. Se respeta el modo dry-run (`runtimeModes.ts`): nunca llama a `registerSale`.
  6. Los permisos se resuelven con la membresía del vendedor (`sales.manual_discount` para precio distinto de lista).
- **Terminado cuando:**
  - la suite del agente (hoy 243 tests) pasa;
  - test de integración de punta a punta: agente → `registerSale` → venta con número, stock y reserva consumida;
  - el reintento tras un tiempo agotado no duplica la venta.

### F6-T11 — Eventos de venta
- **Archivos:** emisión dentro de los casos de uso; prueba del despachador de la Fase 1.
- **Terminado cuando:** cada caso de uso deja exactamente un evento por operación confirmada y ninguno si se revierte.

### F6-T12 — Retiro de lo reemplazado
- **Pasos:**
  1. Quitar los interruptores y eliminar las RPC:
     - `create_sale`, `create_sales_order`, `pay_sales_order`;
     - `generate_sales_order_code` (si DP6-6 lo permite);
     - `resolve_payment_method_code`, `sales_payment_method_guard` y su trigger;
     - `customer_group_for_sale` (si la Fase 4 no lo retiró ya).
  2. Eliminar `products.stock_on_hand` y `products.avg_cost` (D20), y ajustar las vistas que aún las lean.
  3. Eliminar `server/modules/sales/**`.
  4. Inventariar las funciones SQL por finalidad. Conservar las de integridad, Auth, membresías, hook, aislamiento, búsqueda, eventos y lectura que mantienen dependencias vivas; retirar las RPC comerciales sustituidas.
- **Terminado cuando:** la lista de funciones coincide con la permitida y está guardada en `docs/fases/anexos/fase-6-funciones-restantes.md`.

### F6-T13 — Puerta del segundo negocio
- **Ensayo obligatorio en staging.** Con A y B sintéticos, un usuario con ambas membresías elige B y abre caja. Crear un pedido en B a S/ 10, cambiar el precio de catálogo a S/ 12 y cobrar el pedido en efectivo. Simular la pérdida de respuesta después del commit y repetir el cobro con el mismo identificador. Cerrar la caja.
- **Evidencia.** Una venta de S/ 10, un pago, un movimiento de caja, descuento de stock y consumo FIFO por la cantidad vendida una sola vez, reserva consumida y un único número de documento. La caja cuadra y A conserva sus datos. Ejecutar también con el rol sin permiso, membresía suspendida y dos terminales.
- **Operación (D26–D28 y D44).** Antes del alta, el equipo de aplicación configura y prueba los límites de Upstash para login, vinculación, agente y consumo de IA. El responsable de infraestructura valida el correo de invitación y recuperación mediante Resend, el plan comercial de alojamiento y una restauración con PITR en un entorno aislado. Registrar la evidencia en la misma lista de F2.
- **Cierre.** Registrar versión y resultado y actualizar la lista única de [F2 §1.2](fase-2-multi-negocio.md#12-puerta-para-el-segundo-negocio). Los requisitos de fases posteriores quedan pendientes para el alta comercial.

### F6-T14 — Cierre de fase
- **Pasos:** completar el «Registro de cambios»; actualizar `arquitectura.md` con las decisiones de §10; pasar el estado a **Terminada**; validar la Fase 7.

---

## 6. Cómo verificar

```bash
pnpm vitest run tests/unit/sales
```

```bash
pnpm vitest run tests/characterization/create-sale.test.ts tests/characterization/sales-orders.test.ts
```

```bash
for i in $(seq 20); do pnpm vitest run tests/integration/sales || break; done
```

```bash
pnpm vitest run tests/agent
```

- Playwright cubre F6-T13, descuento autorizado, devolución parcial y anulación de otra venta con su caja abierta.
- El control por negocio, producto y ubicación de F5 §5.3 devuelve cero diferencias.

---

## 7. Cómo volver atrás

- Antes de habilitar la vuelta a un motor anterior, ensayar una respuesta perdida tras el commit y el reintento tras cambiar de motor. Debe devolver el mismo documento y mantener pagos, numeración, caja, reservas y FIFO. Aplicar la misma prueba al ejecutor del agente.
- Cuando un motor antiguo carezca de alguna de estas garantías, retirar esa opción de configuración antes de activar las operaciones nuevas. Ante un incidente, pausar el flujo afectado, conciliar por clave de cobro y corregir hacia adelante. Bajar la exigencia de caja no reconstruye los movimientos.

- **Datos:** respaldo previo (D44) antes de T2 y T12.

---

## 8. Riesgos

| Riesgo | Mitigación |
|---|---|
| Una diferencia de céntimos con el cálculo actual (S19 frente a SV1) genera dudas en los cierres | Está documentada como cambio intencional; el informe de paridad lista cada venta con diferencia durante el periodo de staging |
| La serie bloqueada se vuelve un cuello de botella | Se toma al final de la transacción; test de 50 ventas simultáneas; si hiciera falta, una serie por caja |
| Exigir caja abierta frena la operación el primer día | `cash_sessions_required` por negocio; capacitación previa |
| Ventas en espera atrapadas en `localStorage` de algún equipo | Versión de transición que las sube (T8) antes de quitar el modo |
| El agente pierde ventas o las duplica en el cambio | Idempotencia por id de operación + test de reintento + interruptor del ejecutor |
| Eliminar `products.stock_on_hand` rompe pantallas o reportes que aún lo leen | Buscar todos los usos en T12; la Fase 5 ya movió las lecturas al saldo |
| Se abre un segundo negocio antes de tiempo | F6-T13 acredita el cobro en staging y F2 §1.2 concentra todas las condiciones del alta |

---

## 9. Dependencias con otras fases

- **Fase 4:** `resolvePrice` debe reproducir `resolve_sale_item_pricing`, incluido el grupo de cliente (`customer_group_for_sale`).
- **Fase 5:** `consumeFifo`, las reservas y el stock conciliado. F5-T3 modifica `create_sale` de forma mecánica, así que F6-T1 debe existir antes.
- **Fase 8:** el ejecutor del agente se mueve a `layers/modules/agent`.
- **Fase 9:** el pulido de las pantallas de caja, devolución y POS.

---

## 10. Decisiones pendientes para la validación de inicio

| # | Pregunta | Propuesta |
|---|---|---|
| DP6-1 · **Resuelta: D61** | ¿Las ventas en efectivo del agente exigen caja abierta del vendedor? | Sí: el vendedor está físicamente en la tienda. Si no tiene caja abierta, el agente se lo indica antes de confirmar |
| DP6-2 · **Resuelta: D60** | ¿Hasta cuándo se puede anular una venta? | Solo mientras su caja siga abierta; después, se usa una devolución |
| DP6-3 · **Resuelta: D62** | Método de pago desconocido: ¿error o `efectivo`? | Error (SV16) |
| DP6-4 · **Resuelta: D55** | La matriz §10.1 no tiene un permiso de **aprobación** (`approved_by`, S5). ¿Cuál se usa? | Agregar `sales.approve` (dueño y encargado) a la matriz D45 |
| DP6-5 | ¿Vencen las reservas de un pedido? | Sí, configurable por negocio (por defecto 48 h, igual que `posAgentReviewTtlHours`) |
| DP6-6 | ¿El código del pedido pasa a una serie correlativa? | Sí (`P001-000123`), por consistencia con D42 |
| DP6-7 | ¿El ejecutor del agente se mueve ya a `layers/modules/agent` o en la Fase 8? | En la Fase 8; aquí solo se cambia a qué llama |
| DP6-9 | ¿Qué hacer si ya hubo una devolución parcial? | Propuesta pendiente de validación del dueño: continuar devolviendo solo el saldo pendiente y reservar la anulación íntegra para ventas sin devoluciones previas. |
| DP6-8 | ¿Venta con varias formas de pago desde el inicio? | El modelo y la API sí; la interfaz del POS, en la Fase 9 |

---

## 11. Registro de cambios

| Fecha | Cambio | Motivo |
|---|---|---|
| 2026-11-18 | Se definen el precio pactado, la idempotencia entre reintentos, la reversión segura y el ensayo de dos negocios. | Revisión de arquitectura v1.4 |
| 2026-11-18 | Consolidación: DP6-1 a DP6-4 resueltas (D61, D60, D62, D55). F6-T1 se adelanta al inicio de la Fase 5. El precio en pedidos ya exige permiso desde F0-T9; desde la Fase 2 el permiso se puede conceder por usuario (D57). DP6-5 a DP6-8 siguen abiertas para la validación de inicio. | Decisiones del usuario |
| 2026-11-18 | Documento inicial | Plan de fases |
