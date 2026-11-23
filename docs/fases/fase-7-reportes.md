# Fase 7 — Reportes (lado de lectura)

> **Estado:** Por validar al iniciar · **Detalle:** por reporte · Escrito el 2026-11-18, antes de implementar las Fases 0 a 6.
> Arquitectura de referencia: [`../arquitectura.md`](../arquitectura.md) §9 (CQRS ligero), D30 (gráficos), D38 (dinero), D44 (respaldos).
> Auditoría de origen: [`../auditoria-2026-11-18.md`](../auditoria-2026-11-18.md), hallazgos P1–P4.

---

## 1. Objetivo y alcance

**Objetivo.** Que todo reporte y tablero se calcule **en SQL**, por negocio, sin descargar tablas para sumar en JavaScript y sin depender del tope implícito de 1000 filas de Supabase. Debe ser correcto con cualquier volumen y responder en menos de 1 s.

**Entra:**
- Todos los endpoints de lectura agregada: dashboard, resumen financiero, rentabilidad por producto, reporte ejecutivo, reposición por ventas, reposición escolar, análisis de stock de listas escolares y la pestaña «Reportes» del POS.
- Una **vista liviana del catálogo** para las pantallas operativas (P1 de la auditoría).
- Los **índices** que piden esas consultas (P4).
- La **librería de gráficos** (D30) en las páginas de reportes.
- El reporte de caja (cierre Z), si la Fase 6 no lo dejó hecho.

**No entra:**
- Partir las páginas de reportes en componentes: eso es la Fase 9. Aquí solo cambia la fuente de datos y los gráficos.
- Mover los reportes escolares a la capa `verticals/papeleria`: eso es la Fase 8. Aquí se reescriben sus consultas en su ubicación de ese momento.
- La búsqueda de productos (`search_products_hybrid`): ya es SQL y no cambia.

## 2. Requisitos previos

| Requisito | Por qué |
|---|---|
| Fase 2 terminada: `tenant_id` + RLS en todas las tablas | Las funciones de lectura filtran por `current_setting('app.tenant_id')` |
| Fase 5 terminada: stock con una sola fuente, por ubicación (D20) | Los reportes de inventario e inversión leen el saldo derivado, no `products.stock_on_hand` |
| Fase 6 terminada: documento de venta, devoluciones, anulaciones, caja | Los totales de ventas deben restar anulaciones y devoluciones; el cierre Z lee `cash_sessions` |
| Fase 1: Vitest, `seed.sql`, staging | Tests de exactitud y de rendimiento |
| Periodos de reporte (D53) | Rango libre y fecha de inicio de costos por negocio. Identificar los consumidores de los parámetros anteriores. |

---

## 4. Inventario de reportes y tareas

### 4.1 Diagnóstico por reporte (estado al 2026-11-18)

| # | Reporte | Endpoint → página | Fuente actual | Problema |
|---|---|---|---|---|
| R1 | Dashboard | `/api/dashboard/stats` → `pages/index.vue` | `supabaseDashboardRepository.ts:12-18`: `product_catalog` completo + **todas** las `purchases`, `sales` y `stock_movements` de tipo venta, sumadas en JS | Con más de 1000 filas los totales salen **mal** sin aviso (P2). Carga la vista pesada (P1) |
| R2 | Resumen financiero | `/api/reports/financial-summary` → `pages/financial-summary.vue` | `supabaseReportsRepository.ts:345`: catálogo, `purchase_items`, `sale_items`, `stock_movements`, `inventory_count_items`, paginado en serie con `fetchAll` (:320) | Agregación en JS; N viajes por tabla; periodos fijos (`recovery_2025_to_2026_03_08`, `standard_from_2026_03_09` en `reports/ports.ts:117`) propios de la papelería |
| R3 | Rentabilidad por producto | `/api/reports/product-profitability` → `pages/product-profitability.vue` | `supabaseReportsRepository.ts:700`: mismas tablas que R2 | Igual que R2 |
| R4 | Reporte ejecutivo | `/api/reports/executive-profitability` → `pages/executive-profitability.vue` | `getExecutiveProfitability` y `supabaseReportsRepository.ts` construyen totales y series. La página usa `ExecutiveTrendChart` y `ExecutiveCompositionBar`. | Caracterizar contrato, importes y periodos antes de cambiar el cálculo a SQL. |
| R5 | Reposición por ventas | `/api/reports/sales-restock` → `components/stock-ai/SalesSuggestedView.vue` | Handler de 309 líneas: `fetchAll` sobre catálogo, `stock_movements`, `purchase_items`, `sale_items` (:134-172) | Agregación en JS; lógica en el handler |
| R6 | Reposición escolar | `/api/reports/school-restock` → `pages/stock-ai.vue` | Handler de 241 líneas; catálogo completo sin paginar (:127) | Truncado a 1000 productos; vista pesada |
| R7 | Análisis de stock de listas | `/api/school/stock-analysis` y `/api/school/all-lists-stock` → `pages/utiles.vue` | Embeds de `school_lists` → ítems → marcas + `product_catalog` (:61, :93; :24) | Claves foráneas sin índice (`school_list_items.list_id`, `school_list_item_brands.item_id/product_id`); elección de marca repetida en 3 archivos |
| R8 | Pestaña «Reportes» del POS | `pages/sales.vue` (pestaña `reports`, sin endpoint propio) | Calcula sobre `salesHistory`, que trae solo **las últimas 50 ventas** (`supabaseSalesRepository.ts:62`). `totalSalesCount` = `salesHistory.length` (`totalSalesCount`) | «Ventas registradas» e «Ingreso total» muestran solo 50 ventas: el dato es incorrecto |
| R10 | Cierre de caja (Z) | Nuevo (Fase 6) | `cash_sessions` + ventas, devoluciones y pagos de la sesión | Verificar si la Fase 6 lo dejó como consulta SQL; si no, se hace aquí |

### 4.2 Forma del lado de lectura

```text
layers/core/server/contexts/reports/
  queries/          dashboard.ts, salesSummary.ts, financialSummary.ts, productProfitability.ts,
                    executiveProfitability.ts, salesRestock.ts, cashSessionReport.ts
  index.ts          API pública (solo funciones de consulta)
layers/core/server/api/reports/*.get.ts       defineApiHandler({ permission: 'reports.costs' | 'reports.sales', query: zod })
supabase/migrations/<ts>_reports_*.sql        funciones SQL STABLE + vistas + índices
```

**Reglas de esta fase:**
- **Sin capa hexagonal.** Una consulta es `handler → query → función SQL`. No hay dominio que proteger (§9).
- **Funciones `STABLE`, `SECURITY INVOKER`.** Filtran con `tenant_id = current_setting('app.tenant_id')::uuid` además de RLS (para que el planificador use el índice).
- **Se agrupan las fechas en la zona horaria del negocio** (`tenant_settings.timezone`): `(sale_date AT TIME ZONE tz)::date`. Nunca en UTC ni en la zona del servidor.
- **Los montos salen de SQL como `numeric`** y viajan como texto. El frontend los formatea con `utils/format.ts` (D38). Nada de `float` intermedio.
- **El backend no devuelve presentación:** sin colores ni textos de UI. Devuelve datos y la página decide cómo mostrarlos.
- Presupuesto inicial de tres consultas por endpoint. Todas se ejecutan bajo el contexto verificado de lectura del negocio. Medir el p95 con el dataset de F7-T1.
- **Listas con paginación explícita** (`limit`/cursor) o con un tope declarado en el contrato.

### 4.3 Tareas

#### F7-T0 — Validación de reportes y periodos
- **Objetivo:** contrastar los contratos actuales con D53 y elegir la librería de gráficos prevista en D30.
- **Pasos:**
  1. Revalidar la tabla 4.1 contra el código: archivos y líneas pueden haber cambiado en las Fases 1 a 6.
  2. Confirmar qué reportes dejó listos la Fase 6 (R10).
  3. Aplicar D53. Mapear los parámetros históricos al nuevo selector de fechas durante la transición y retirar los alias junto con su último consumidor. Acordar con el dueño cómo imputar devoluciones entre periodos. Probar la propuesta de reconocer la venta en su fecha local, el reverso en su fecha efectiva y el movimiento de caja en la sesión que lo recibió. Conciliar dos días y verificar que cada reversión se contabilice una vez.
  4. Elegir ECharts (`vue-echarts`) o Unovis (D30) con una prueba de un gráfico de R4. *Criterio:* el que dé tema claro y oscuro con menos código.
- **Terminado cuando:** los contratos y su transición están registrados, hay un ejemplo acordado de devolución entre periodos y se eligió la librería.

#### F7-T1 — Dataset de rendimiento y arnés de pruebas
- **Objetivo:** poder medir exactitud y tiempo de cada reporte antes de cambiarlo.
- **Archivos:** `supabase/seed-perf.sql` (o un script `scripts/seed-perf.mjs`), `tests/integration/reports/*.test.ts`, `tests/perf/reports.bench.ts`.
- **Pasos:**
  1. Generar datos sintéticos para **2 negocios**: por negocio, 5.000 productos, 20.000 ventas, 100.000 líneas de venta, 5.000 líneas de compra, 3 años de historial, 2 ubicaciones.
  2. Para cada reporte, escribir un **cálculo de referencia** independiente (SQL directo y simple en el test) y un test que compare el resultado del endpoint contra él.
  3. Arnés `vitest bench` que mida p95 por endpoint contra Supabase local.
  4. Correr el arnés contra la implementación actual y guardar la línea base en el «Registro de cambios».
- **Terminado cuando:** existe la línea base de tiempo de cada reporte y los tests de exactitud corren (los actuales pueden fallar por truncado: se documenta).

#### F7-T2 — Índices
- **Objetivo:** que los índices sirvan a los rangos y agrupaciones reales y que el tiempo medido cumpla el presupuesto por reporte.
- **Archivos:** `supabase/migrations/<ts>_reports_indexes.sql` + su rollback en `supabase/rollbacks/`.
- **Índices** (todos empiezan por `tenant_id`; los nombres de tabla se ajustan a la Fase 6):
  - `sales (tenant_id, sale_date)` y `sales (tenant_id, created_at DESC)`;
  - `sale_items (tenant_id, product_id)` y `sale_items (tenant_id, sale_id)`;
  - `purchases (tenant_id, purchase_date)`, `purchase_items (tenant_id, product_id)`;
  - `stock_movements (tenant_id, movement_type, created_at)` y `(tenant_id, product_id, created_at)`;
  - `inventory_count_items (tenant_id, applied, applied_at)`;
  - `sale_cost_allocations (tenant_id, sale_item_id)`;
  - trigram: `products USING gin (name gin_trgm_ops)` y `customers USING gin (name gin_trgm_ops)`;
  - claves foráneas escolares: `school_list_items (list_id)`, `school_list_item_brands (item_id)` y `(product_id)` (o sus nombres `pap_*` si la Fase 8 ya los renombró).
- **Pasos:** crear con `CREATE INDEX CONCURRENTLY` en producción (fuera de transacción: migración separada), `pnpm db:backup` antes (D44).
- **Terminado cuando:** los planes con el dataset de F7-T1 cumplen el presupuesto del reporte. Justificar los recorridos completos que el planificador elija para agregaciones de periodos amplios.

#### F7-T3 — Vista liviana del catálogo
- **Objetivo:** que las pantallas operativas dejen de pagar el cálculo de FIFO y costos de `product_catalog` (P1).
- **Archivos:** migración con `product_catalog_lite`; repositorios o consultas de POS, compras, precios, inventario, combos y dashboard.
- **Contenido de la vista:** producto + categoría + unidad + `item_kind` + saldo por ubicación (saldo derivado de la Fase 5) + precio vigente. **Sin** laterales de FIFO ni de costo promedio.
- **Pasos:**
  1. Crear la vista con `security_invoker = true`.
  2. Reemplazar cada uso operativo de `product_catalog` (al 2026-11-18: `supabaseSalesRepository.ts:19`, `supabaseProductsRepository.ts:96`, `supabasePurchasesRepository.ts:19`, `supabasePricingRepository.ts:27`, `supabaseInventoryRepository.ts:47`, `supabaseDashboardRepository.ts:12`; tras las Fases 3–6 serán adaptadores Drizzle) por la vista liviana.
  3. Dejar `product_catalog` (o su sucesora) **solo** para reportes de costo.
  4. `ensureAutoSku` (`supabaseProductsRepository.ts:38`): si sigue existiendo, consultar `products` (índice único en `sku`), no la vista.
- **Terminado cuando:** `grep product_catalog` fuera de `contexts/reports` no devuelve nada; el POS carga el catálogo en menos de 300 ms con 5.000 productos.

#### F7-T4 — R1 Dashboard
- **Objetivo:** totales correctos con cualquier volumen.
- **SQL:** `report_dashboard(p_from date, p_to date)` → una fila: ventas netas (descontando anulaciones y devoluciones), número de ventas, compras, costo de lo vendido, margen bruto, productos bajo stock mínimo, valor del inventario.
- **Archivos:** función SQL; `contexts/reports/queries/dashboard.ts`; `api/dashboard/stats.get.ts` (ruta conservada); `pages/index.vue` (solo la fuente de datos).
- **Permiso:** `reports.sales` para los totales de venta; los campos de costo y margen solo con `reports.costs` (si no, `null`).
- **Terminado cuando:** el test de exactitud pasa con 20.000 ventas (hoy fallaría) y p95 < 300 ms.

#### F7-T5 — R8 Resumen de ventas del POS
- **Objetivo:** que la pestaña «Reportes» del POS deje de calcular sobre las últimas 50 ventas.
- **SQL:** `report_sales_summary(p_from, p_to, p_location uuid default null, p_seller uuid default null)` → totales, ticket promedio, ventas por método de pago, por vendedor y por hora.
- **Archivos:** función SQL; `queries/salesSummary.ts`; nuevo `api/reports/sales-summary.get.ts`; en `pages/sales.vue` la pestaña `reports` consume el endpoint en lugar de sumar `salesHistory`. Coordinar con F9-T2, que parte esa página.
- **Permiso:** `reports.sales`.
- **Terminado cuando:** con 20.000 ventas, «Ventas registradas» coincide con `count(*)` del periodo; el historial del POS sigue paginado y separado del resumen.

#### F7-T6 — R2 Resumen financiero
- **SQL:** `report_financial_summary(p_from, p_to)` → ingresos, costo FIFO (desde `sale_cost_allocations`), margen, compras, ajustes de inventario valorizados, valor del inventario al cierre. Sin periodos fijos (decisión F7-T0).
- **Archivos:** función SQL; `queries/financialSummary.ts`; `api/reports/financial-summary.get.ts`; `pages/financial-summary.vue` (selector de rango en vez de periodos fijos).
- **Permiso:** `reports.costs`.
- **Terminado cuando:** test de exactitud en verde y p95 < 1 s; se eliminan `getFinancialSummary` del repositorio antiguo y los alias `LEGACY_PERIOD_ALIASES` del handler.

#### F7-T7 — R3 Rentabilidad por producto
- **SQL:** `report_product_profitability(p_from, p_to, p_limit, p_offset, p_sort)` → por producto: unidades vendidas (en unidad base), ingresos, costo FIFO, margen, % margen, rotación. **Paginado.**
- **Archivos:** función SQL; `queries/productProfitability.ts`; ruta y `pages/product-profitability.vue` (paginación en la tabla).
- **Permiso:** `reports.costs`.
- **Terminado cuando:** test de exactitud en verde con 5.000 productos y p95 < 1 s por página.

#### F7-T8 — R4 Reporte ejecutivo
- **Objetivo:** pasar los totales y series del reporte que usa la papelería a SQL con paridad en fechas, cantidades, costos y márgenes.
- **SQL**, dividido por bloque del reporte:
  - `report_exec_series(p_from, p_to, p_bucket text)` → series por día, semana, mes o año (ventas, costo, margen, compras), con `date_trunc` en la zona del negocio;
  - calcular totales y series semanales, mensuales y anuales con el mismo rango y permisos. Añadir solo indicadores que tengan un consumidor acordado.
- **Archivos:** funciones SQL, `queries/executiveProfitability.ts`, `api/reports/executive-profitability.get.ts`, `pages/executive-profitability.vue` y sus dos componentes de gráficos. Migrar página y API coordinadamente y conservar la ruta. Caracterizar carga, cambio de periodo y visualización de las series antes de retirar el adaptador anterior.
- **Permiso:** `reports.costs`.
- **Terminado cuando:** el reporte muestra los mismos números que la referencia de F7-T1; p95 < 1 s con 3 años de historial; ningún color ni texto de UI en el backend.

#### F7-T9 — R5 Reposición por ventas
- **SQL:** `report_sales_restock(p_days int, p_location uuid)` → por producto: venta promedio diaria en la ventana, stock disponible (saldo − reservas), días de cobertura, cantidad sugerida, último costo y proveedor de la última compra.
- **Archivos:** función SQL; `queries/salesRestock.ts`; `api/reports/sales-restock.get.ts` queda en unas 20 líneas; `components/stock-ai/SalesSuggestedView.vue` (solo la fuente).
- **Permiso:** `purchases.register`, como en F0 para el reporte de reposición que expone costos de compra.
- **Terminado cuando:** test de exactitud en verde y p95 < 1 s.

#### F7-T10 — R6 y R7 Reportes escolares
- **Objetivo:** las mismas reglas para los reportes de la papelería, antes de que la Fase 8 los mueva a su capa.
- **SQL:**
  - `report_school_restock(p_year int)` (R6) → demanda proyectada por producto según las listas activas, contra el stock disponible;
  - `report_school_list_stock(p_list_id uuid)` y `report_school_all_lists_stock(p_year int)` (R7) → cobertura de cada lista con la marca elegida por defecto. **Una sola** regla de elección de marca (hoy repetida en `all-lists-stock.get.ts:50-70`, `stock-analysis.get.ts:120-160` y `schoolList.ts:200-245`).
- **Archivos:** funciones SQL; handlers de `api/reports/school-restock`, `api/school/stock-analysis`, `api/school/all-lists-stock`; páginas `stock-ai.vue` y `utiles.vue` (solo la fuente).
- **Permiso:** mantener la restricción de reposición escolar de F0 (`purchases.register`) y el acceso de lectura de listas según su contrato. F8 registra los permisos del módulo.
- **Terminado cuando:** con 5.000 productos los resultados no se truncan y p95 < 1 s.

#### F7-T11 — R10 Cierre de caja (si falta)
- **SQL:** `report_cash_session(p_session_id uuid)` → apertura, ventas por método de pago, devoluciones, retiros e ingresos de efectivo, esperado contra contado, diferencia.
- **Permiso:** `cash.operate` para la propia sesión; `cash.view_all` para las demás.
- **Terminado cuando:** el cierre Z cuadra con el test de referencia.

#### F7-T12 — Retiro de adaptadores y cierre del acceso directo (D46)
- **Pasos:**
  1. Borrar `fetchAll`, `supabaseReportsRepository.ts`, `supabaseDashboardRepository.ts` y los módulos `server/modules/reports` y `server/modules/dashboard` antiguos.
  2. Regla de lint (o test) que falle si un archivo en `contexts/reports` usa `.range(` en bucle o importa el cliente de Supabase.
  3. Inventariar adaptadores PostgREST y RPC de **todas** las funciones que siguen operativas, incluidas papelería y agente. Mover los accesos a datos restantes al backend con verificación de negocio, incluso si el traslado de la ruta a su capa corresponde a F8. Conservar la integración con Supabase Auth.
  4. Tras probar esos consumidores, revocar los privilegios directos de `authenticated` sobre datos comerciales y la ejecución de RPC comerciales aún expuestas, incluidos privilegios heredados de `PUBLIC`. Probar en staging POS, compras, listas, agente y reportes con los permisos finales. Registrar evidencia en [F2 §1.2](fase-2-multi-negocio.md#12-puerta-para-el-segundo-negocio).
- **Terminado cuando:** concuerdan los resultados SQL, los flujos siguen operando con los permisos finales y una sesión ordinaria carece de acceso directo a datos comerciales.

---

## 5. Cómo verificar

| Verificación | Cómo |
|---|---|
| Exactitud | `pnpm vitest run tests/integration/reports`: cada reporte contra su cálculo de referencia, con 2 negocios (también comprueba que no se mezclan datos) |
| Rendimiento | `pnpm vitest bench tests/perf/reports.bench.ts` contra Supabase local con el dataset de F7-T1: **p95 < 1 s** en todos; < 300 ms en dashboard y catálogo del POS |
| Planes de ejecución | Guardar `EXPLAIN (ANALYZE, BUFFERS)` para un rango corto y otro amplio y justificar el costo medido. |
| Sin truncado | Test con 20.000 ventas y 5.000 productos: los conteos coinciden con `count(*)` |
| Aislamiento | El test de aislamiento de la Fase 2 cubre las rutas nuevas |
| Páginas | Playwright: cada página de reportes carga sin error y muestra los gráficos |
| Staging | Mismo bench con un volumen parecido al de producción antes de publicar |

## 6. Cómo volver atrás

- **Funciones, vistas e índices son aditivos.** Cada migración tiene su script en `supabase/rollbacks/` (`DROP FUNCTION`, `DROP INDEX`).
- **Un PR por reporte.** Si un reporte nuevo da números dudosos en producción, se revierte su PR y vuelve el endpoint anterior, que se borra recién en F7-T12.
- **F7-T12 se hace al final**, cuando todos los reportes llevan un tiempo estables.
- `pnpm db:backup` antes de cada migración en producción (D44).

## 7. Riesgos

| Riesgo | Mitigación |
|---|---|
| **Los números cambian respecto a los reportes actuales** (los actuales están truncados o mal calculados) | Explicar cada diferencia contra el cálculo de referencia; dejarla anotada en el «Registro de cambios» y avisar al dueño antes de publicar |
| Funciones lentas por RLS | Filtro explícito por `tenant_id` + índices que empiezan por `tenant_id` |
| Agrupar por día en la zona equivocada | Toda agrupación usa `tenant_settings.timezone`; test con ventas cerca de la medianoche |
| `CREATE INDEX` bloquea tablas en producción | `CONCURRENTLY`, en migración separada, fuera del horario de atención |
| Plan gratuito de Supabase (D44): límite de cómputo | Medir en staging; si el reporte ejecutivo sigue pesado, vista materializada que se refresca con `pg_cron` |
| Conflicto con la Fase 9 en las mismas páginas | Aquí solo se toca la fuente de datos y los gráficos; la Fase 9 parte la página después |

## 8. Registro de cambios

| Fecha | Cambio |
|---|---|
| 2026-11-18 | Se verificó el reporte ejecutivo de main y se precisaron la conciliación por periodo y el cierre del acceso directo a los datos. |
| 2026-11-18 | Consolidación: D53 resuelve los periodos de reporte (rango libre + `tenant_settings.reporting_start_date`). |
| 2026-11-18 | Documento inicial (antes de implementar). |
