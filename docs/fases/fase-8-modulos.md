# Fase 8 — Módulos (Nuxt Layers y activación por negocio)

> **Estado:** Por validar al iniciar · **Detalle:** por módulo · Escrito el 2026-11-18, antes de implementar las Fases 0 a 7.
> Arquitectura de referencia: [`../arquitectura.md`](../arquitectura.md) §3 (niveles), §4 (dependencias), §8 (extensión, manifiesto, Layers), §12 (agente), §13 (estructura), §16 (eliminaciones); decisiones D5, D17, D18, D19, D36, D45.

---

## 1. Objetivo y alcance

**Objetivo.** Que cada capacidad opcional sea un **módulo** (Nuxt Layer) que se activa o desactiva **por negocio**. El núcleo no debe conocer ningún módulo. Al terminar:
- la papelería funciona igual que antes, con sus módulos activos;
- un negocio de prueba sin esos módulos no los ve en el menú y recibe 404 en sus rutas.

**Entra:**

| Módulo | Nivel | Origen |
|---|---|---|
| Infraestructura de módulos (`defineModule`, registro, activación, menú, plantillas) | Núcleo | Nuevo |
| `core` (consolidación) | Núcleo | Todo lo que quede fuera de `layers/` |
| `agent` (Yachay) | Transversal | `server/modules/agent`, `server/api/agent/*`, `pages/vincular.vue`, `pages/ventas-por-confirmar.vue` |
| `kits` | Transversal | `pages/combos.vue`, `server/api/combos/*`, `combo_workspaces` |
| `papeleria` | Vertical | `institutions`, `school_*`, `server/api/school/*`, `server/api/utiles/*`, `pages/utiles.vue`, `pages/school-lists.vue`, reposición escolar de `pages/stock-ai.vue` |
| Plantillas de giro | Núcleo | Nuevo (`business_type` → módulos, unidades y categorías iniciales) |

**No entra:**
- Cotizaciones a clientes (`quotes`, D63). Se programan después de F9. Las cotizaciones a proveedores ya pertenecen a compras.
- `credit` (crédito/fiado, D11) y `einvoice-pe` (facturación SUNAT, D10): son módulos **futuros**. Esta fase solo deja lista la infraestructura que usarán.
- Los verticales `ferreteria` y `taller`: no se construyen hasta tener clientes (§17).
- WhatsApp: se elimina en la Fase 0 (D17) y se rehace más adelante como canal del agente.
- Partir las páginas en componentes: Fase 9. Aquí las páginas **se mueven** de capa sin rediseñarse.

## 2. Requisitos previos

| Requisito | Por qué |
|---|---|
| Fases 1 a 7 terminadas | Los módulos llaman la API pública del núcleo (`registerSale`, `reserveStock`, `resolvePrice`, `saveProduct`) |
| `tenant_modules` creada (Fase 2) | Activación por negocio |
| Outbox y despachador funcionando (Fase 1) | Suscripciones de módulos a eventos |
| Ramas del agente mergeadas o archivadas (pendiente #2 de la arquitectura: `selector-autocorreccion`, `supervisor-integracion`, `registrador-sin-literal`, `agente1-decisivo`, `cantidad-numeros-descriptivos`) | La tarea F8-T6 borra código del agente |
| Validación final del benchmark del selector `llm` (pendiente #6, D19) | Requisito para borrar `legacy` |
| Composición de kits en catálogo y consumo de componentes en inventario (D50) | El planificador crea kits mediante el contrato público del núcleo. |

---

## 4. Tareas

### F8-T0 — Validación de inicio y decisiones pendientes
- **Pasos:**
  1. Aplicar la regla de validación de `README.md`. Revalidar la lista de archivos de cada módulo: las Fases 1 a 7 movieron mucho código.
  2. Verificar el contrato del planificador con catálogo (D50) y el consumo FIFO del kit con ventas e inventario.
  3. Validar el aprovisionamiento, rotación y revocación de las credenciales por negocio previstas en D54.
  4. Confirmar que no queda ninguna dependencia del núcleo hacia los módulos de esta fase (`dependency-cruiser`).
- **Terminado cuando:** documento validado y decisiones registradas.

### F8-T1 — Infraestructura de módulos
- **Objetivo:** el mecanismo común que usan todos los módulos (§8.4 y §8.5).
- **Archivos:**
  - `layers/core/server/shared/modules/defineModule.ts`: tipo `ModuleManifest` (`id`, `name`, `kind: 'core' | 'module' | 'vertical'`, `dependsOn`, `permissions` con su valor por defecto por rol, `menu`, `productAttributes` (zod), `extensions`, `subscribes`, `routes`: prefijos de API y de páginas);
  - `layers/core/server/shared/modules/registry.ts` recibe manifiestos mediante su contrato. `server/plugins/modules.ts` en la aplicación raíz importa estáticamente los manifiestos y les inyecta los adaptadores compartidos de búsqueda e IA (D67).
  - `layers/core/server/shared/http/guard.ts`: además de sesión y negocio, responde **404** si la ruta pertenece a un módulo inactivo para el negocio;
  - `layers/core/server/api/modules/*.ts`: listar módulos activos (para el cliente) y activar o desactivar (`settings.manage`; valida `dependsOn`);
  - `layers/core/app/middleware/module.global.ts`: en el cliente, redirige si la página es de un módulo inactivo;
  - registro de puntos de extensión (`priceModifier`, `saleValidator`) y de suscripciones a eventos, filtrados por módulos activos del negocio.
- **Reglas:**
  - activar un módulo exige que sus dependencias estén activas; desactivar uno exige que nadie activo dependa de él;
  - desactivar **no borra datos**: el módulo solo deja de verse;
  - los permisos de módulo se suman a la matriz de §10.1 con sus valores por rol.
- **Terminado cuando:** test de integración con un módulo de prueba: activo → ruta 200 y en el menú; inactivo → 404 y fuera del menú; suscripción a evento solo se ejecuta si está activo.

### F8-T2 — Menú desde los manifiestos
- **Objetivo:** reemplazar el menú escrito a mano.
- **Archivos:** `app.vue` (hoy 858 líneas, con `navItems` fijo en las líneas 26-130: 17 entradas en los grupos «operación» y «gestión»); `layers/core/app/stores/modules.ts` (`useModulesStore`); `layers/core/app/components/AppSidebar.vue`.
- **Pasos:**
  1. Cada manifiesto declara sus entradas de menú con grupo, orden y permiso.
  2. `useModulesStore` carga el menú del negocio seleccionado. Invalidarlo al cambiar de negocio, permisos o sesión.
  3. La barra lateral muestra solo entradas de módulos activos **y** con permiso del usuario.
- **Terminado cuando:** el menú de la papelería es idéntico al de hoy; un cajero no ve «Rentabilidad», «Reglas de venta», «Usuarios» ni «Mantenimiento» (D45).

### F8-T3 — Consolidar el núcleo en `layers/core`
- **Objetivo:** ubicar la funcionalidad de negocio en su capa y conservar la composición de módulos en la raíz (D36, D67).
- **Pasos:**
  1. Inventariar lo que siga en la raíz: `pages/`, `components/`, `server/api/`, `server/modules/`, `server/utils/`, `utils/productSearch.ts`, `composables/useTheme.ts`, `middleware/`.
  2. Moverlo a `layers/core` o al módulo que corresponda (tabla del punto 1).
  3. Manifiesto `core` con las entradas de menú del núcleo: Dashboard, Caja y TPV, Compras, Inventario, Productos, Clientes, Proveedores, Rentabilidad, Resumen financiero, Reporte ejecutivo, Reglas de venta, Mantenimiento, Usuarios.
  4. La raíz conserva configuración, entrada mínima y el plugin de composición. Los contratos que usa el plugin pertenecen al núcleo.
- **Terminado cuando:** la única importación conjunta de manifiestos concretos está en la composición de la aplicación y `dependency-cruiser`, build y tests pasan.

### F8-T4 — Módulo `agent`: estado en la base de datos (D18)
- **Objetivo:** que el agente funcione en Vercel y por negocio. Hoy guarda todo en archivos (`.data/agent`).
- **Origen:** `server/modules/agent/infra/fileAgentStore.ts` (implementa `AgentStore`, `contracts.ts:177`: requests, operations, `exclusive`) y `fileSellerSessionStore.ts` (implementa `SellerSessionStore`, `sellerSessions.ts:70`: identifications, sessions).
- **Archivos:**
  - migración con `agent_requests`, `agent_operations`, `agent_identifications`, `agent_seller_sessions`, todas con `tenant_id` + RLS;
  - `layers/modules/agent/server/infrastructure/drizzleAgentStore.ts` y `drizzleSellerSessionStore.ts`, que implementan los **mismos puertos** (no cambia la lógica);
  - `exclusive()` → `pg_advisory_xact_lock` por negocio dentro de una transacción;
  - los límites de intentos fallidos de `/vincular` (por código, correo e IP) pasan a la base.
- **Datos existentes:** las sesiones vencen a las 23:59 de Lima y las operaciones en revisión a las 48 h (`posAgentReviewTtlHours`). *Propuesta:* no migrar archivos; publicar fuera de horario, cuando no haya operaciones abiertas. Se confirma en F8-T0.
- **Terminado cuando:**
  - la suite del agente pasa con los adaptadores nuevos;
  - dos instancias en paralelo no procesan la misma operación (test de concurrencia de `exclusive`);
  - las instancias nuevas usan el mismo estado en la base y dejan de escribir archivos. Retirar los adaptadores antiguos tras verificar operaciones y sesiones en curso.

### F8-T5 — Módulo `agent`: credenciales y contexto por negocio
- **Objetivo:** reemplazar el único `POS_AGENT_TOKEN` (`server/utils/agent.ts:31`) por credenciales de cada negocio.
- **Diseño acordado (D54):**
  - tabla `agent_credentials(tenant_id, token_hash, label, created_at, revoked_at)`; el token se muestra una sola vez al crearlo (`settings.manage`);
  - la comparación sigue siendo de tiempo constante (`timingSafeEqual`), ahora contra el hash;
  - el negocio se resuelve **desde la credencial**, no desde lo que diga la instrucción;
  - en el conector Yachay, cada negocio es un «sistema» en `systems.json` con su propio `service_token_env`.
- **Archivos:** `server/utils/agent.ts` (o su sucesor en la capa), `api/agent/context.get.ts` (hoy fija `'PEN'`: debe leer `tenant_settings`), `integrations/yachay-connector/systems.json` y su documentación (`docs/yachay-agent-api.md`).
- **Terminado cuando:** test de aislamiento: la credencial del negocio A no puede leer el catálogo ni registrar ventas en el negocio B.

### F8-T6 — Módulo `agent`: eliminar el modo `legacy` (D19)
- **Requisito:** validación final del benchmark del selector `llm` (pendiente #6) y ramas del agente resueltas.
- **Pasos:**
  1. Default `llm` en `runtimeModes.ts` (`resolveSelectorMode`, que hoy cae a `legacy`) y en `nuxt.config.ts` (`posAgentSelector`).
  2. En `server/utils/agent.ts` (`getAgentHandler`): eliminar la rama de `makeHybridDraftBuilder` y el `console.warn` que nunca se ejecuta (líneas 99-103 al 2026-11-18).
  3. Borrar los archivos que **solo usa** el camino legacy, verificados por importaciones al 2026-11-18:
     - `app/draftBuilder.ts`;
     - `infra/openaiOrderInterpreter.ts`;
     - `infra/openaiProductSelector.ts`.
  4. Revisar, **sin borrar a ciegas**, los que también usa el camino `llm` a través de `catalogAnswers.ts` → `prepareSale.ts`: `contextSelection.ts`, `prepareSale.ts`, `agent1Contracts.ts`, `sellerChoice.ts`. Se borra solo lo que quede sin referencias tras el paso 3.
  5. Borrar lo que solo usan los tests: `app/priceReview.ts` y `selectorMode` en `salesSelector.ts` (duplica `resolveSelectorMode`).
  6. Eliminar `SelectorMode` y `posAgentSelector` si ya no hay dos modos; actualizar los tests (`tests/contextSelection.test.mjs` y los que dependan del legacy).
- **Terminado cuando:** no queda referencia a `legacy` en el código; los tests del agente pasan; el benchmark del selector da el mismo resultado que antes de borrar.

### F8-T7 — Módulo `agent`: mover a su capa
- **Pasos:**
  1. Mover `server/modules/agent` a `layers/modules/agent/server/` (ya es hexagonal: `app/` → `application/`, `infra/` → `infrastructure/`, `contracts.ts` → `domain/`).
  2. Mover `server/api/agent/*`, `pages/vincular.vue` y `pages/ventas-por-confirmar.vue`, con su middleware de revisión. Verificar permisos de aprobación y anulación en la API.
  3. Mover `server/plugins/agentModes.ts`.
  4. Manifiesto: `id: 'agent'`, `kind: 'module'`, permisos `agent.sessions.view` y `agent.sessions.revoke` (dueño), sección «Sesiones de Claude» en Usuarios.
  5. Confirmar que el agente registra **solo** por casos de uso del núcleo (`registerSale`, `reserveStock`), nunca por RPC (§12). Debió quedar así en la Fase 6.
- **Terminado cuando:** con el módulo inactivo, las rutas de API del módulo responden 404 a identidades válidas y las páginas de vinculación y revisión quedan inaccesibles. Probar también la protección específica de cada canal con el módulo activo.

### F8-T8 — Cotizaciones a clientes, diferidas por D63

Número reservado para trazabilidad. El desarrollo se planificará después de F9.

### F8-T9 — Módulo `kits`
- **Según D50:**
  1. Mover `pages/combos.vue`, `server/api/combos/*` y `combo_workspaces` (renombrada `kit_workspaces`, con `tenant_id`) a `layers/modules/kits/`.
  2. Acción «Convertir en kit»: crea el producto `item_kind = kit` con su composición mediante `saveProduct` del núcleo.
  3. Eliminar el modo de respaldo en `localStorage` (`combos.vue:483-493`): con la base disponible no hace falta. Puede hacerse aquí o en F9-T6.
- **Permisos:** `kits.plan` (dueño y encargado).
- **Terminado cuando:** un combo planificado se convierte en kit, se vende en el POS y descuenta el stock de sus componentes (esto lo resuelve el núcleo).

### F8-T10 — Vertical `papeleria`: datos y API
- **Pasos:**
  1. Renombrar las tablas con prefijo de módulo: `institutions` → `pap_institutions`, `school_grades` → `pap_grades`, `school_sections` → `pap_sections`, `school_lists` → `pap_lists`, `school_list_items` → `pap_list_items`, `school_list_item_brands` → `pap_list_item_brands`. Ya tienen `tenant_id` (Fase 2). Referencian `products` del núcleo; el núcleo no las referencia.
  2. Mover las rutas escolares operativas y `server/api/reports/school-restock.get.ts` a `layers/verticals/papeleria/server/` con `defineApiHandler`. Revisar el inventario tras F0 y F7.
  3. Obtener precios mediante `resolvePrice` (F4) y conservar la regla de elección de marca unificada en F7.
  4. Manifiesto `papeleria` de tipo `vertical`, con permisos `school_lists.view`, `school_lists.edit` y `school_stock.view`, y entradas «Útiles», «Compra escolar» y «Listas escolares». Declarar atributos de producto solo cuando los requiera la papelería.
- **Terminado cuando:** la papelería funciona igual; un negocio de prueba sin el módulo no tiene esas tablas visibles ni esas rutas.

### F8-T11 — Vertical `papeleria`: páginas, lectura de lista por foto y cotización escolar
- **Pasos:**
  1. Mover `pages/utiles.vue`, `pages/school-lists.vue` y la parte escolar de `pages/stock-ai.vue` («Compra escolar», que consume `school-restock`). La parte de reposición por ventas (`SalesSuggestedView.vue`) y las cotizaciones a proveedores (`QuotesView.vue`) **quedan en el núcleo** (compras).
  2. **Reimplementar la lectura de lista por foto.** Hoy `api/utiles/analyze-image` y `api/utiles/match` usan `server/utils/aiLogic.ts` (`analyzeImageCore`, `matchProductsCore`), con modelos fijos, la función `match_products`, las tablas `image_cache` y `match_cache` y la columna `products.embedding` con su índice `ivfflat`. Nueva versión:
     - lectura de la imagen por el puerto compartido `ProveedorIA`, con modelo configurable y adaptador inyectado en la aplicación raíz;
     - búsqueda mediante el puerto compartido `BuscadorProductos` y `search_products_hybrid`;
     - sin reglas de idioma fijas (principio «la IA interpreta y el código verifica»).
  3. Borrar `aiLogic.ts`, `match_products`, `image_cache`, `match_cache`, `products.embedding` y su índice, y `scripts/embed-catalog.mjs` si aún existe.
  4. Conservar la preparación de la lista escolar y su paso al POS. Caracterizar la salida que existe en la versión desplegada antes de mover la página. Una impresión existente puede seguir como presentación de la lista independientemente de `quotes`.
  5. El paso de la lista al carrito del POS (hoy por `localStorage`, `utiles.vue:1195-1220`) usa `useCartStore` cuando exista (F9-T2).
- **Terminado cuando:** la lectura por foto reconoce una lista de prueba con al menos la misma tasa de acierto que la versión anterior (medida sobre un conjunto de fotos de referencia); `aiLogic.ts` ya no existe.

### F8-T12 — Plantillas de giro
- **Objetivo:** que crear un negocio deje todo listo según su giro (§8.5).
- **Archivos:** `layers/core/server/contexts/identity/templates/*.ts`; caso de uso `createTenant` (Fase 2) recibe `business_type`.
- **Plantillas iniciales:**
  - `generic` («Comercio»): solo núcleo; unidades básicas (unidad, paquete, caja, docena), categorías vacías, métodos de pago (efectivo, tarjeta, transferencia, Yape/Plin);
  - `papeleria`: núcleo, `papeleria` y `kits`, con las unidades y categorías iniciales de la tienda y sin productos;
  - el módulo `agent` se activa aparte, no por plantilla.
- **Terminado cuando:** crear un negocio de prueba con cada plantilla deja los módulos, unidades y categorías esperados; test automático.

### F8-T13 — Pruebas de activación, aislamiento y limpieza
- **Pasos:**
  1. Tests: por cada módulo, activo contra inactivo (rutas, menú, eventos, puntos de extensión).
  2. Ampliar el test de aislamiento a `pap_*`, `kit_*` y `agent_*`. Con `papeleria` activa y `agent` inactivo, la lectura por foto sigue funcionando y no se exponen rutas del agente. Verificar entrega de eventos por suscriptor y negocio.
  3. Reglas de `dependency-cruiser`: núcleo → módulo prohibido; módulo → módulo solo si está en `dependsOn`.
  4. Actualizar `arquitectura.md` §8 y §13 con lo aprendido y `docs/yachay-agent-api.md` con las credenciales por negocio.
- **Terminado cuando:** CI en verde con las reglas nuevas.

---

## 5. Cómo verificar

| Verificación | Cómo |
|---|---|
| Activación | Tests de F8-T1 y F8-T13: activo → 200 y menú; inactivo → 404, sin menú, sin eventos |
| Papelería sin cambios para el usuario | Playwright: los flujos de útiles, listas escolares, compra escolar, combos y POS funcionan igual que antes de la fase |
| Agente | Tests del agente + benchmark del selector + prueba manual con el conector local (`integrations/yachay-connector/LOCAL.md`) |
| Aislamiento | Test de aislamiento ampliado; credencial de un negocio contra otro |
| Capas | `dependency-cruiser` en CI |
| Lectura por foto | Conjunto de fotos de referencia: tasa de acierto ≥ la actual |

## 6. Cómo volver atrás

- **Un PR por tarea.** Mover archivos de capa es reversible con `git revert`.
- **Renombrar tablas** (F8-T10, F8-T9): migración con rollback en `supabase/rollbacks/` (`ALTER TABLE … RENAME`). `pnpm db:backup` antes (D44).
- **Estado del agente** (F8-T4): antes del corte, drenar o preservar las operaciones en curso. Una vez haya escrituras en la base, cualquier reversión debe conservarlas. Ensayar la recuperación en staging antes de publicar.
- **Lectura por foto** (F8-T11): no borrar `aiLogic.ts` hasta que la versión nueva supere el conjunto de referencia.
- **Legacy del agente** (F8-T6): es la única tarea sin vuelta atrás simple; por eso exige el benchmark aprobado antes.

## 7. Riesgos

| Riesgo | Mitigación |
|---|---|
| Borrar código del agente que el camino `llm` sí usa | Borrar solo lo verificado por importaciones (F8-T6 paso 3); el resto, cuando quede sin referencias; tests y benchmark |
| Ramas del agente sin mergear generan conflictos | Requisito previo: resolverlas antes de F8-T4 |
| La lectura por foto empeora | Conjunto de fotos de referencia y comparación antes de borrar la versión anterior |
| Perder operaciones del agente al cambiar de almacenamiento | Publicar sin operaciones abiertas; sesiones vencen cada día |
| El núcleo termina dependiendo de un módulo | `dependency-cruiser` lo bloquea en CI |
| Diseñar extensiones que nadie usa | Solo se implementan los puntos de extensión que un módulo de esta fase necesita; los de crédito y taller, cuando lleguen |
| Desactivar un módulo con datos | Desactivar oculta; nunca borra |

## 8. Registro de cambios

| Fecha | Cambio |
|---|---|
| 2026-11-18 | Se alinearon la composición de módulos, las dependencias de búsqueda e IA y el alcance de kits y cotizaciones con D50, D54, D63 y D67. |
| 2026-11-18 | Consolidación: **F8-T8 (módulo `quotes`) sale de esta fase** por D63; la papelería no depende de `quotes` y conserva su impresión de cotización actual. Kits según D50. Agente: `agent_credentials` y moneda desde `tenant_settings` (D54). La lectura de listas por foto se reimplementa aquí (D49). |
| 2026-11-18 | Documento inicial (antes de implementar). |
