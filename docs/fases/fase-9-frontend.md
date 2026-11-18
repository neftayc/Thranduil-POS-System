# Fase 9 — Frontend (páginas, componentes y estado)

> **Estado:** Por validar al iniciar (puede avanzar en paralelo desde la Fase 1) · **Detalle:** por página · Escrito el 2026-11-18.
> Arquitectura de referencia: [`../arquitectura.md`](../arquitectura.md) §11 (frontend y regla de Pinia), D29 (Nuxt UI + VueUse), D30 (gráficos), D31 (zod compartido), D34 (Nuxt 4), D36, D45 (permisos).

---

## 1. Objetivo y alcance

**Objetivo.** Que ninguna página pase de unas **500 líneas**. Cada página orquesta; la interfaz va en componentes por funcionalidad; los datos del servidor se piden con composables, y solo el estado global de sesión y de flujo vive en Pinia. Todo con componentes de Nuxt UI, sin iconos SVG escritos a mano.

**Entra:** páginas y componentes de `main` (`5b4f612`). El orden de trabajo depende de la estabilidad de su backend.

| Página o componente | Líneas | Destino |
|---|---:|---|
| `pages/sales.vue` | 2655 | Núcleo |
| `pages/utiles.vue` | 1948 | Vertical papelería |
| `pages/executive-profitability.vue` | 527 | Núcleo (reportes) |
| `pages/products.vue` | 1641 | Núcleo |
| `pages/combos.vue` | 1621 | Módulo `kits` |
| `pages/school-lists.vue` | 1398 | Vertical papelería |
| `pages/purchases.vue` | 1060 | Núcleo |
| `components/stock-ai/QuotesView.vue` | 1299 | Núcleo (compras) |
| `pages/pricing.vue` | 833 | Núcleo |
| `pages/inventory.vue` | 989 | Núcleo |
| `app.vue` (estructura y menú) | 867 | Núcleo |
| `pages/product-profitability.vue` | 799 | Núcleo (reportes) |
| `pages/stock-ai.vue` | 743 | Núcleo + vertical papelería |
| `pages/maintenance.vue` | 682 | Núcleo |
| `components/stock-ai/SalesSuggestedView.vue` | 585 | Núcleo (compras) |
| `pages/financial-summary.vue`, `index.vue`, `customers.vue`, `users.vue`, `suppliers.vue`, `login.vue`, `vincular.vue` | 103–440 | Núcleo / `agent` |
| `pages/ventas-por-confirmar.vue` | 337 | Módulo `agent`, revisión y aprobación de ventas |
| `pages/stock-suggested.vue`, `pages/supplier-quotes.vue` | 3 c/u | Validar consumidores antes de retirar las redirecciones |

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
  | `useSessionStore` | usuario, negocio activo, rol, permisos, `can(permission)` | F1-T16, integración en F9-T1 |
  | `useModulesStore` | módulos activos y menú | Base en F1-T16, manifiestos en F8-T2 |
  | `useCartStore` | carrito del POS, cliente, método de pago, borrador persistido | F9-T2 |
  | `useCashStore` | sesión de caja abierta, arqueo en curso | F9-T2 (con el backend de la Fase 6) |

- **Carga y errores:** un composable `useAsyncAction()` (estado `loading`, `error`, notificación con el toast de Nuxt UI). Reemplaza los bloques repetidos `try / loading / message`.
- **Formato:** centralizar dinero, cantidades y fechas en `utils/format.ts` con los ajustes del negocio. Inventariar las funciones existentes al empezar cada pantalla.
- **Componentes de Nuxt UI** para tabla, formulario, modal, menú, pestañas, toast y selector. **Iconos con Iconify** (hoy hay 41 `<svg>` escritos a mano y emojis como iconos).
- **Formularios** validados con el **mismo esquema zod** que la API (D31).
- **Permisos:** mostrar u ocultar con `useSessionStore().can(...)` según la matriz de §10.1. Nunca como única protección.
- **Búsquedas** con `useDebounce` (VueUse) y textos normalizados una sola vez al cargar.
- **Estado por terminal.** Guardar preferencias y, si procede, el borrador del POS bajo la clave de usuario, negocio y ubicación. Mantener tokens en cookies `HttpOnly`. Al salir o cambiar de contexto, cancelar peticiones anteriores, invalidar cachés y limpiar carrito, caja, permisos y módulos en memoria. Si otra pestaña comparte la sesión, sincronizar el cambio antes de permitir cobrar. Descartar respuestas tardías del contexto anterior.
- **Antes de partir una página, un test Playwright** que fije su comportamiento actual (test de caracterización de punta a punta).

### 4.2 Tareas

#### F9-T0 — Validación de inicio
- Aplicar la regla de validación de `README.md` **por cada página**, al iniciarla: tamaños, líneas citadas y endpoints cambian con las otras fases.
- **Terminado cuando:** la página a refactorizar tiene su sección revisada y anotada en el «Registro de cambios».

#### F9-T1 — Estructura común, sesión y formato
- **Objetivo:** la base que usan todas las demás tareas.
- **Archivos:** `app.vue` (867 líneas) → `layouts/default.vue` + `components/layout/AppSidebar.vue`, `AppHeader.vue`, `UserMenu.vue`; `stores/session.ts`; `composables/useAsyncAction.ts`; `utils/format.ts`.
- **Pasos:**
  1. Sacar el menú y la cabecera de `app.vue` a componentes con Nuxt UI. Mientras no exista `useModulesStore` (Fase 8), el menú sigue siendo una lista fija, pero filtrada por permisos.
  2. `useSessionStore` comparte una carga de `/api/auth/me` por inicialización. Revalidar al renovar, cambiar de negocio o recuperar una pestaña con contexto antiguo. Con 401 definitivo volver al login, con 403 mostrar acceso restringido o el selector y con 503 conservar el contexto y permitir reintento. El backend verifica cada operación.
  3. `owner.ts` se reemplaza por un middleware de **permiso** (`definePageMeta({ permission: 'reports.costs' })`).
  4. Adoptar `utils/format.ts` en los 14 archivos con formato propio.
  5. Tema claro y oscuro: `composables/useTheme.ts` se reemplaza por el modo de color de Nuxt UI si cubre lo mismo.
- **Terminado cuando:** la carga inicial se comparte entre componentes y el test con dos negocios demuestra que una respuesta tardía, un borrador anterior y un cambio en otra pestaña no mezclan usuarios, negocios ni ubicaciones.

#### F9-T2 — `pages/sales.vue` (2655 líneas) · después de la Fase 6
- **Hoy:** `SalesTab` reúne POS, historial, cobro y reportes. Caracterizar atajos (`handlePosHotkeys`), búsqueda (`handleSearchKeydown`), comprobante e impresión antes de extraerlos.
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
  | `PosTicketPanel.vue` | Extraer del flujo de impresión y conservar el comprobante actual |

- **Estado:** `useCartStore` y `useCashStore` respetan el ámbito del terminal. Conservar la clave del cobro pendiente de F6 a través de recargas y reintentos hasta conocer su resultado.
- **Eliminar:**
  - el modo local de pedidos en espera, previa conciliación de los pedidos existentes según F6-T8;
  - los restos de notificación por WhatsApp que sobrevivan a F0-T2;
  - los totales calculados sobre las últimas 50 ventas, cuando esté disponible F7-T5;
- **Rendimiento:**
  - búsqueda con debounce y textos normalizados al cargar el catálogo;
  - repreciado del carrito por lote al cambiar de cliente con `resolve-batch`, entregado por F4-T9;
- **Integración:** `addItems(lines)` recibe las líneas escolares en el carrito del negocio y ubicación activos.
- **Terminado cuando:**
  - los tests Playwright de caracterización (venta simple, venta con unidades y descuento, venta en espera y cobro, cambio de cliente con repreciado, atajos de teclado, impresión) pasan antes y después;
  - ningún archivo pasa de 500 líneas;
  - cambiar de cliente con 15 ítems reprecia en una sola llamada.

#### F9-T3 — `pages/utiles.vue` (1948 líneas) · junto con F8-T11
- **Hoy:** análisis de stock por lista, consulta de todas las listas, lectura por foto, búsqueda y paso al carrito mediante `localStorage`.
- **División:** `pages/utiles.vue`, `ListSelector.vue`, `ListStockAnalysis.vue`, `AllListsStock.vue`, `PhotoListReader.vue` y `ListMatchReview.vue` en la capa papelería.
- **Cambios:** el paso al carrito usa `useCartStore().addItems`. Preservar la preparación actual de listas. Las cotizaciones a clientes quedan para después de F9 (D63).
- **Terminado cuando:** Playwright cubre analizar una lista, leer una foto de referencia y enviar la lista al POS.

#### F9-T4 — `pages/executive-profitability.vue` (527 líneas) · después de F7-T8
- **Hoy:** la página consume `/api/reports/executive-profitability` y muestra totales, composición y series semanales, mensuales y anuales. `ExecutiveCompositionBar` y `ExecutiveTrendChart` están activos en `main`.
- **División:** reutilizar los dos componentes, extraer la tabla de series repetida y caracterizar el cambio de periodo. Coordinar cambios del contrato y de los gráficos con F7-T8.
- **Terminado cuando:** la página muestra los mismos datos que antes; ningún archivo > 500 líneas; sin SVG de gráficos a mano.

#### F9-T5 — `pages/products.vue` (1641 líneas) · después de la Fase 3
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

#### F9-T8 — `pages/purchases.vue` (1060 líneas) · después de la Fase 5
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

#### F9-T10 — `pages/pricing.vue` (833 líneas) · después de la Fase 4
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
- `customers.vue`, `suppliers.vue`, `users.vue`, `login.vue`, `vincular.vue` y `ventas-por-confirmar.vue`: adoptar los componentes comunes. Las dos últimas pantallas del agente conservan sus reglas propias de vinculación y revisión.
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
| Sesión y permisos | Playwright con un cajero y con un usuario de dos negocios. Verificar selector, caja y carrito después del cambio, rechazo de respuestas tardías y salida en un terminal mientras el otro conserva su sesión. |
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
| 2026-11-18 | Se contrastaron pantallas y reporte ejecutivo con main y se definió la invalidación de estado por usuario, negocio y ubicación. |
| 2026-11-18 | Consolidación: la vista de pedidos de `sales.vue` ya no tiene la notificación por WhatsApp (F0-T2). Los botones de acciones de escritura se ocultan por permiso desde F0-T9 y, en esta fase, se derivan de `useSessionStore` (incluidas las concesiones por usuario de D57). |
| 2026-11-18 | Documento inicial (antes de implementar). |
