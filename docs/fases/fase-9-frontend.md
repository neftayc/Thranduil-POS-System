# Fase 9 — Frontend (páginas, componentes y estado)

> **Estado:** Por validar al iniciar (puede avanzar en paralelo desde la Fase 1) · **Detalle:** por página · Escrito el 2026-11-18.
> Arquitectura de referencia: [`../arquitectura.md`](../arquitectura.md) §11 (frontend y regla de Pinia), D29 (Nuxt UI + VueUse), D30 (gráficos), D31 (zod compartido), D34 (Nuxt 4), D36, D45 (permisos).

---

## 1. Objetivo y alcance

**Objetivo.** Que ninguna página pase de unas **500 líneas**. Cada página orquesta; la interfaz va en componentes por funcionalidad; los datos del servidor se piden con composables, y solo el estado global de sesión y de flujo vive en Pinia. Todo con componentes de Nuxt UI, sin iconos SVG escritos a mano.

**Entra:** todas las páginas de `pages/` y los componentes grandes de `components/`, por orden de tamaño (al 2026-11-18):

| Página o componente | Líneas | Destino |
|---|---:|---|
| `pages/sales.vue` | 3461 | Núcleo |
| `pages/utiles.vue` | 2999 | Vertical papelería |
| `pages/executive-profitability.vue` | 2978 | Núcleo (reportes) |
| `pages/products.vue` | 1788 | Núcleo |
| `pages/combos.vue` | 1621 | Módulo `kits` |
| `pages/school-lists.vue` | 1398 | Vertical papelería |
| `pages/purchases.vue` | 1374 | Núcleo |
| `components/stock-ai/QuotesView.vue` | 1299 | Núcleo (compras) |
| `pages/pricing.vue` | 1029 | Núcleo |
| `pages/inventory.vue` | 989 | Núcleo |
| `app.vue` (estructura y menú) | 858 | Núcleo |
| `pages/product-profitability.vue` | 799 | Núcleo (reportes) |
| `pages/stock-ai.vue` | 743 | Núcleo + vertical papelería |
| `pages/maintenance.vue` | 682 | Núcleo |
| `components/stock-ai/SalesSuggestedView.vue` | 585 | Núcleo (compras) |
| `pages/financial-summary.vue`, `index.vue`, `customers.vue`, `users.vue`, `suppliers.vue`, `login.vue`, `vincular.vue` | 103–440 | Núcleo / `agent` |
| `pages/stock-suggested.vue`, `pages/supplier-quotes.vue` | 3 c/u | Redirecciones: borrar si ya no se usan |

**No entra:**
- Cambios de backend. Si una página necesita un endpoint nuevo (por ejemplo, el repreciado del carrito en lote), se pide a la fase dueña del contexto.
- Rediseño visual completo. Se adoptan los componentes de Nuxt UI con el estilo actual; el rediseño, si se quiere, es otro proyecto.
- Modo sin conexión (D16).

### Cómo convive con las demás fases

Esta fase **no espera** a las anteriores. Avanza **página por página desde la Fase 1**, con tres reglas:

1. **Una página se refactoriza cuando su backend está estable.** Por ejemplo, `sales.vue` después de la Fase 6; las páginas de reportes después de su tarea en la Fase 7; las de la papelería después o junto con la Fase 8.
2. **No se refactoriza una página que otra fase está tocando** en ese momento: se coordina en el tablero de tareas.
3. Las tareas transversales (F9-T1: estructura, sesión, formato) van **primero**, apenas termina la Fase 1.

---

## 2. Requisitos previos

| Requisito | Para qué |
|---|---|
| Fase 1: Nuxt 4, Tailwind 4, Nuxt UI, VueUse, Pinia, `utils/format.ts`, Playwright | Todo lo que usa esta fase |
| Fase 1: `defineApiHandler` + permisos en el backend | El frontend solo oculta; la seguridad es del servidor |
| Esquemas zod compartidos en `shared/` (D31) | Formularios |
| Backend estable de cada página (ver «Cómo convive») | Evitar refactorizar dos veces |

---

## 4. Reglas comunes y tareas

### 4.1 Reglas que aplican a todas las páginas

- **Página = orquestador.** Lee la ruta, llama composables y monta componentes. Objetivo ≤ 500 líneas por archivo `.vue` (regla de lint `max-lines` en F9-T14).
- **Componentes por funcionalidad** en `app/components/<funcionalidad>/` de su capa.
- **Datos del servidor → composables** (`useProducts`, `useSalesHistory`, `usePurchases`…) sobre `useFetch`/`$fetch`. **No se copian a Pinia** (§11).
- **Pinia solo para estado global:**

  | Store | Contenido | Se crea en |
  |---|---|---|
  | `useSessionStore` | usuario, negocio activo, rol, permisos, `can(permission)` | F9-T1 |
  | `useModulesStore` | módulos activos y menú | Fase 8 (F8-T2) |
  | `useCartStore` | carrito del POS, cliente, método de pago, borrador persistido | F9-T2 |
  | `useCashStore` | sesión de caja abierta, arqueo en curso | F9-T2 (con el backend de la Fase 6) |

- **Carga y errores:** un composable `useAsyncAction()` (estado `loading`, `error`, notificación con el toast de Nuxt UI). Reemplaza los bloques repetidos `try / loading / message`.
- **Formato:** `utils/format.ts` (dinero, números, fechas según `tenant_settings`). Hoy hay `formatMoney`, `moneyFormatter` o `toNumber` propios en 14 archivos (`financial-summary`, `executive-profitability`, `inventory`, `combos`, `purchases`, `product-profitability`, `index`, `utiles`, `stock-ai`, `sales`, `SalesSuggestedView`, `QuotesView`, `ExecutiveBucketRail`, `ExecutiveCompositionBar`).
- **Componentes de Nuxt UI** para tabla, formulario, modal, menú, pestañas, toast y selector. **Iconos con Iconify** (hoy hay 41 `<svg>` escritos a mano y emojis como iconos).
- **Formularios** validados con el **mismo esquema zod** que la API (D31).
- **Permisos:** mostrar u ocultar con `useSessionStore().can(...)` según la matriz de §10.1. Nunca como única protección.
- **Búsquedas** con `useDebounce` (VueUse) y textos normalizados una sola vez al cargar.
- **`localStorage` solo para preferencias** (por ejemplo, la disposición del POS) y el borrador del carrito, siempre mediante `useStorage` con manejo de errores. Nunca como base de datos alternativa.
- **Antes de partir una página, un test Playwright** que fije su comportamiento actual (test de caracterización de punta a punta).

### 4.2 Tareas

#### F9-T0 — Validación de inicio
- Aplicar la regla de validación de `README.md` **por cada página**, al iniciarla: tamaños, líneas citadas y endpoints cambian con las otras fases.
- **Terminado cuando:** la página a refactorizar tiene su sección revisada y anotada en el «Registro de cambios».

#### F9-T1 — Estructura común, sesión y formato
- **Objetivo:** la base que usan todas las demás tareas.
- **Archivos:** `app.vue` (858 líneas) → `layouts/default.vue` + `components/layout/AppSidebar.vue`, `AppHeader.vue`, `UserMenu.vue`; `stores/session.ts`; `composables/useAsyncAction.ts`; `utils/format.ts`.
- **Pasos:**
  1. Sacar el menú y la cabecera de `app.vue` a componentes con Nuxt UI. Mientras no exista `useModulesStore` (Fase 8), el menú sigue siendo una lista fija, pero filtrada por permisos.
  2. `useSessionStore`: hoy `/api/auth/me` se pide en `middleware/auth.global.ts`, `middleware/owner.ts`, `app.vue:264` y `sales.vue:1593`. Pasa a pedirse **una vez** por sesión; los middlewares leen el store.
  3. `owner.ts` se reemplaza por un middleware de **permiso** (`definePageMeta({ permission: 'reports.costs' })`).
  4. Adoptar `utils/format.ts` en los 14 archivos con formato propio.
  5. Tema claro y oscuro: `composables/useTheme.ts` se reemplaza por el modo de color de Nuxt UI si cubre lo mismo.
- **Terminado cuando:** `/api/auth/me` se llama una vez por carga; no quedan funciones de formato de dinero fuera de `utils/format.ts`.

#### F9-T2 — `pages/sales.vue` (3461 líneas) · después de la Fase 6
- **Hoy:** 4 pestañas en un archivo (`pos` :2345, `history` :2786, `checkout` :2927, `reports` :3141; tipo `SalesTab` :49), atajos de teclado (`handlePosHotkeys`, :2332), búsqueda con `handleSearchKeydown` (:2486, :2687), impresión con `PosTicketPanel` (ya extraído).
- **División propuesta:**

  | Pieza | Contenido |
  |---|---|
  | `pages/sales.vue` | Pestañas, ruta (`?view=`), atajos globales |
  | `components/sales/PosView.vue` | Disposición del POS |
  | `ProductSearchPanel.vue` | Búsqueda con debounce, resultados, lector de código de barras |
  | `CartPanel.vue`, `CartLine.vue` | Líneas, cantidades, unidades, descuento manual (`sales.manual_discount`) |
  | `CustomerPicker.vue` | Cliente y grupo de cliente |
  | `PaymentDialog.vue` | Cobro y métodos de pago |
  | `HeldSalesDrawer.vue` | Ventas en espera (pedidos) |
  | `CheckoutView.vue` | Pedidos por cobrar |
  | `HistoryView.vue` | Historial paginado (`useSalesHistory`) |
  | `ReportsView.vue` | Resumen del periodo (endpoint de F7-T5) |
  | `CashSessionBar.vue` | Caja abierta, cierre (`useCashStore`) |
  | `PosTicketPanel.vue` | Ya existe |

- **Estado:** `useCartStore` (carrito, cliente, precios resueltos, borrador con `useStorage`, que reemplaza `DRAFT_STORAGE_KEY` y el `watch` profundo de :2287-2292) y `useCashStore`.
- **Eliminar:**
  - el **modo local de ventas en espera**: `HOLD_STORAGE_KEY` (:264), `isOrdersBackendMissing` (:268-280), escrituras y lecturas (:1081, :1122-1190). Con la migración base las tablas existen siempre;
  - el aviso por WhatsApp (`/api/webhook/notify-order-ready`, :2119), si la Fase 0 no lo quitó ya (D17);
  - los totales calculados sobre las últimas 50 ventas (:100-150): los reemplaza `ReportsView`.
- **Rendimiento:**
  - búsqueda con `useDebounce` (~120 ms) y textos normalizados al cargar el catálogo (hoy se normalizan 4 campos por producto en cada tecla, :1762 y :1814);
  - repreciado del carrito al cambiar de cliente **en lote**: hoy `refreshCartPricing` (:1034) hace un HTTP por ítem en serie. Requiere un endpoint en lote de `resolvePrice` (pedirlo a la Fase 4 o 6).
- **Integración:** `addItems(lines)` en `useCartStore` para recibir listas desde la papelería (reemplaza el puente por `localStorage` de `utiles.vue:1195-1220`).
- **Terminado cuando:**
  - los tests Playwright de caracterización (venta simple, venta con unidades y descuento, venta en espera y cobro, cambio de cliente con repreciado, atajos de teclado, impresión) pasan antes y después;
  - ningún archivo pasa de 500 líneas;
  - cambiar de cliente con 15 ítems reprecia en una sola llamada.

#### F9-T3 — `pages/utiles.vue` (2999 líneas) · junto con F8-T11
- **Hoy:** análisis de stock por lista, stock de todas las listas, lectura de lista por foto, búsqueda manual, impresión de cotización como HTML armado con texto (:954) y paso al carrito por `localStorage` (:1195-1220).
- **División:** `pages/utiles.vue` (orquesta) + en `layers/verticals/papeleria/app/components/utiles/`: `ListSelector.vue`, `ListStockAnalysis.vue`, `AllListsStock.vue`, `PhotoListReader.vue`, `ListMatchReview.vue`, `SchoolQuotePrint.vue`; composables `useSchoolStockAnalysis`, `usePhotoListReader`.
- **Cambios:** la cotización se imprime con un componente (o con el módulo `quotes`, según F8-T11); el paso al carrito usa `useCartStore().addItems`.
- **Terminado cuando:** Playwright cubre analizar una lista, leer una foto de referencia y enviar la lista al POS.

#### F9-T4 — `pages/executive-profitability.vue` (2978 líneas) · después de F7-T8
- **Hoy:** unas 1.760 líneas de script con 60 `computed`, plantilla desde :1763 en secciones (`top`, `decision`, `kpis`, cinco bloques `grid2`, `scenarios`, `card`) y unas 600 líneas de CSS propio desde :2365. Gráficos dibujados a mano en SVG.
- **División:** un componente por sección (`ExecHeader`, `ExecDecision`, `ExecKpis`, `ExecSalesChart`, `ExecWaterfall`, `ExecInventoryComposition`, `ExecScenarios`…) en `components/reports/executive/`; gráficos con la librería elegida en F7-T0; estilos con Tailwind y Nuxt UI en lugar del CSS propio.
- **Lógica:** lo que la Fase 7 entrega ya calculado se borra del frontend; lo que es presentación (colores, textos, tonos) queda en un composable `useExecutivePresentation`.
- **Componentes `Executive*.vue`** (`ExecutiveBucketRail`, `ExecutiveCompositionBar`, `ExecutiveGroupedBarChart`, `ExecutiveTrendChart`): hoy sin uso y con cambios sin commitear. Se reutilizan o se borran según lo que decida el usuario (pendiente #1).
- **Terminado cuando:** la página muestra los mismos datos que antes; ningún archivo > 500 líneas; sin SVG de gráficos a mano.

#### F9-T5 — `pages/products.vue` (1788 líneas) · después de la Fase 3
- **División:** `ProductTable.vue` (tabla de Nuxt UI, paginada), `ProductForm.vue` (con `item_kind` y atributos según los esquemas de los módulos activos, §8.2), `ConversionsEditor.vue`, `ExcelImportDialog.vue`; composable `useProducts`.
- **Cambios:**
  - `xlsx` con **carga diferida**: hoy se importa siempre (`products.vue:2`) y solo se usa al importar (:808) → `const XLSX = await import('xlsx')` dentro de `ExcelImportDialog`;
  - búsqueda con `utils/productSearch.ts` + debounce.
- **Terminado cuando:** `nuxi analyze` muestra `xlsx` en un chunk aparte que no se carga al abrir la página; Playwright cubre crear, editar, conversiones e importación.

#### F9-T6 — `pages/combos.vue` (1621 líneas) · junto con F8-T9
- **División:** `ComboList.vue`, `ComboEditor.vue`, `ComboLineRow.vue`, `ComboPricing.vue` (modos `base_cost`, `plus10`, `absolute`); composable `useKitWorkspace`.
- **Eliminar:** el respaldo en `localStorage` (`LOCAL_COMBO_STORAGE_KEY`, :483-493), igual que el modo local del POS.
- **Terminado cuando:** guardar, recargar y convertir en kit funcionan; ningún archivo > 500 líneas.

#### F9-T7 — `pages/school-lists.vue` (1398 líneas) · junto con F8-T10
- **División:** `SchoolHierarchyPicker.vue` (institución → grado → sección), `ListHeaderForm.vue`, `ListItemsEditor.vue`, `BrandVariantsEditor.vue`; composable `useSchoolLists`.
- **Terminado cuando:** crear y editar una lista con variantes de marca funciona igual; Playwright en verde.

#### F9-T8 — `pages/purchases.vue` (1374 líneas) · después de la Fase 5
- **División:** `PurchaseList.vue`, `PurchaseForm.vue` (hoy un modal en :897), `PurchaseLineRow.vue`, `PurchaseCorrectionDialog.vue` (corrección de ítems, `correctPurchase`); composable `usePurchases`.
- **Permisos:** `purchases.register`.
- **Terminado cuando:** registrar y corregir una compra funciona; Playwright en verde.

#### F9-T9 — Reposición y cotizaciones a proveedores (`stock-ai.vue` 743, `QuotesView.vue` 1299, `SalesSuggestedView.vue` 585) · después de F7-T9 y F8-T11
- **Separación por capa:**
  - **núcleo (compras):** `SalesSuggestedView` (reposición por ventas) y `QuotesView` (cotizaciones a proveedores), en una página de compras sugeridas;
  - **papelería:** «Compra escolar» (reposición escolar).
- **División de `QuotesView`:** `SupplierQuoteList.vue`, `SupplierQuoteEditor.vue`, `QuoteLineRow.vue`; composable `useSupplierQuotes`.
- **Borrar** `pages/stock-suggested.vue` y `pages/supplier-quotes.vue` (redirecciones de 3 líneas) si ya no hay enlaces a ellas.
- **Terminado cuando:** ninguna pieza > 500 líneas; el menú lleva a cada parte según el módulo activo.

#### F9-T10 — `pages/pricing.vue` (1029 líneas) · después de la Fase 4
- **Hoy:** el bloque `try / loading / message` se repite 17 veces.
- **División:** un componente por tipo de regla: `WholesaleTiersEditor.vue`, `PromotionsEditor.vue`, `PresentationPricesEditor.vue`, `CustomerGroupPricesEditor.vue`; formularios con los esquemas zod compartidos; `useAsyncAction`.
- **Permisos:** `pricing.edit` (solo dueño).
- **Terminado cuando:** las cuatro reglas se crean, editan y borran; Playwright en verde.

#### F9-T11 — `pages/inventory.vue` (989 líneas) · después de la Fase 5
- **División:** `CountSessionHeader.vue`, `CountTable.vue`, `ApplyAdjustmentsDialog.vue`, `TransferDialog.vue` (transferencias entre ubicaciones, Fase 5).
- **Permisos:** `inventory.count` (registrar) frente a `inventory.apply` (aplicar).
- **Terminado cuando:** un cajero puede contar pero no aplicar; Playwright en verde.

#### F9-T12 — Reportes restantes · después de su tarea en la Fase 7
- `product-profitability.vue` (799): tabla paginada de Nuxt UI, filtros de rango, gráficos con la librería de F7-T0.
- `financial-summary.vue` (440): selector de rango (sin periodos fijos) y tarjetas.
- `index.vue` (316): tarjetas del dashboard (F7-T4) según permisos.

#### F9-T13 — Páginas menores
- `maintenance.vue` (682): un componente por catálogo (unidades, categorías, métodos de pago, grupos de cliente).
- `customers.vue`, `suppliers.vue`, `users.vue` (incluye «Sesiones de Claude» del módulo `agent`), `login.vue`, `vincular.vue`: adoptar Nuxt UI, `format.ts` y `useSessionStore`.
- **Terminado cuando:** todas usan los componentes base y ninguna supera 500 líneas.

#### F9-T14 — Cierre
- **Pasos:**
  1. Regla ESLint `max-lines` (500) para `.vue` en `app/` de todas las capas, en CI.
  2. Verificar que no queden `<svg>` de iconos escritos a mano (búsqueda en CI o revisión).
  3. Suite Playwright mínima en CI: login, venta, compra, cierre de caja.
  4. Actualizar `arquitectura.md` §11 con lo aprendido.
- **Terminado cuando:** CI en verde con las reglas nuevas.

---

## 5. Cómo verificar

| Verificación | Cómo |
|---|---|
| Comportamiento | Playwright de caracterización por página, escrito **antes** de partirla, en verde antes y después |
| Tamaño | ESLint `max-lines` 500 en `.vue` |
| Estado | Tests de Vitest de los stores (`useCartStore`: agregar, cambiar cliente, persistir y restaurar borrador; `useSessionStore`: `can()` según la matriz de §10.1) |
| Rendimiento | Búsqueda del POS con 5.000 productos sin bloqueo perceptible; `xlsx` fuera del chunk inicial (`nuxi analyze`) |
| Permisos | Playwright con un usuario cajero: no ve lo que la matriz no le permite |
| Visual | Revisión en el navegador de cada página, en claro y oscuro, en escritorio y tablet |

## 6. Cómo volver atrás

- **Un PR por página** (o por pieza grande de `sales.vue`). Solo cambia frontend: `git revert` deja la versión anterior.
- `sales.vue` se parte **en varios PR** (primero `HistoryView` y `ReportsView`, al final el POS), para que un error no deje sin caja a la tienda.
- Publicar los cambios del POS **fuera del horario de atención** y con el flujo de publicación existente.

## 7. Riesgos

| Riesgo | Mitigación |
|---|---|
| Romper el POS, la pantalla más usada | Tests Playwright de caracterización primero; varios PR pequeños; publicar fuera de horario |
| Perder atajos de teclado o el flujo del lector de código de barras | Incluirlos en los tests de caracterización (`handlePosHotkeys`, `handleSearchKeydown`) |
| Refactorizar una página dos veces | Regla «backend estable primero»; coordinar con la fase dueña |
| Copiar datos del servidor a Pinia | Regla de §11 en `AGENTS.md`/`CLAUDE.md` y revisión de código |
| Cambio visual que confunde a los cajeros | Mantener la disposición actual; solo cambiar los componentes base |
| Diferencias entre Nuxt UI y el CSS propio (sobre todo en `executive-profitability.vue`) | Revisar en claro y oscuro antes de publicar |

## 8. Registro de cambios

| Fecha | Cambio |
|---|---|
| 2026-11-18 | Consolidación: la vista de pedidos de `sales.vue` ya no tiene la notificación por WhatsApp (F0-T2). Los botones de acciones de escritura se ocultan por permiso desde F0-T9 y, en esta fase, se derivan de `useSessionStore` (incluidas las concesiones por usuario de D57). |
| 2026-11-18 | Documento inicial (antes de implementar). |
