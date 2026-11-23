# Fase 1 — Cimientos

> Estado: **Por validar al iniciar** · Detalle: completo (archivo por archivo) · Referencias verificadas contra el repositorio el 2026-11-18.

## 1. Objetivo y alcance

Dejar listo el terreno para la refactorización **sin cambiar la funcionalidad del negocio**:
- framework actualizado (D34);
- estructura `layers/` (D36);
- herramientas de calidad que bloquean el merge (D24, D25);
- entornos y datos de prueba (D43);
- tipos de dinero (D38);
- seguridad por defecto (guard + `defineApiHandler` con la matriz §10.1);
- acceso transaccional a Postgres (Drizzle + `app_backend` + `UnitOfWork`, D37);
- outbox (D23);
- Pinia, Nuxt UI y VueUse (D29);
- formato común;
- borrado del código muerto.

**Fuera de alcance:**
- multi-negocio (`tenant_id`, `memberships`), que es la Fase 2;
- mover lógica de negocio fuera de PL/pgSQL (Fases 3 a 6);
- partir páginas (Fase 9).

Las rutas existentes **no** se migran a `defineApiHandler` en esta fase. Se migran cuando se toca cada contexto.

**Negocio implícito antes de la Fase 2.** Todavía no existe `tenant_id`. Para que el código nuevo nazca preparado:
- `layers/core/server/shared/domain/tenant.ts` define `DEFAULT_TENANT_ID = '00000000-0000-0000-0000-000000000001'`. Es el id que tendrá la papelería en la Fase 2.
- El guard y `TenantContext` devuelven siempre ese id.
- `UnitOfWork` ya fija `app.tenant_id` y `app.user_id` en cada transacción, aunque ninguna política los lea todavía.
- Los permisos salen de `profiles.role` (vía `getUserRole`, `server/utils/auth.ts`) hasta que la Fase 2 cree `memberships`.

## 2. Requisitos previos

| # | Requisito |
|---|---|
| P1 | Fase 0 terminada y en producción |
| P2 | Identificar cambios activos que se solapen con el movimiento de carpetas. |
| P3 | Cuentas creadas: Sentry (plan gratuito) y segundo proyecto Supabase para staging. Renovate se instala como GitHub App |
| P4 | Ejecutar `pnpm test:agent` en la rama de inicio y registrar resultado y número de pruebas como línea base. |

## 4. Tareas en orden

### F1-T0 · Línea base del POS

Ejecutar primero en Nuxt 3 los recorridos de login, venta, pedido, compra, conteo y consulta del reporte ejecutivo con datos locales sintéticos y resultados conocidos. Adelantar de F1-T6/T8 el mínimo de fixtures y Playwright necesario. Guardar los mismos escenarios en CI y repetirlos tras el cambio de runtime y framework. El entorno de preview usa datos de prueba.

### F1-T1 · Validación de Node 26 LTS + Nuxt 4, sin cambios funcionales (D34)

- **Objetivo:** validar Nuxt 4, Nuxt UI y el árbol de dependencias con Node 26 LTS. Comparar contra F1-T0. Si surge una incompatibilidad, registrarla y revisar D34 antes de fijar la versión.
- Comprobar el soporte del proveedor junto con las pruebas de la aplicación. [Calendario de Node.js](https://github.com/nodejs/Release/blob/main/schedule.json) y [versiones admitidas por Vercel](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions).
- **Archivos:**
  - `.nvmrc` (`20` → `26` tras validar);
  - `package.json` (`engines.node` `26.x`; `nuxt` `^4`);
  - `pnpm-lock.yaml`;
  - `nuxt.config.ts`;
  - carpetas movidas a `app/`.
- **Pasos:**
  1. Mover a `app/` el código del cliente: `app.vue`, `assets/`, `components/`, `composables/`, `middleware/`, `pages/` y `utils/` (`utils/productSearch.ts`, importado como `~/utils/productSearch` en 5 páginas). Así esas importaciones siguen funcionando, porque en Nuxt 4 `~` apunta a `app/`.
  2. Borrar `plugins/`, que está vacía.
  3. `server/`, `public/` y `shared/` (nuevo) quedan en la raíz.
  4. `nuxt.config.ts`:
     - `css: ['~/assets/css/main.css']` sigue válido;
     - revisar `ignore` (`.claude/**`, `supabase/**`, `integrations/**/.venv/**`) y `vite.server.watch.ignored`;
     - quitar el host fijo de ngrok en `allowedHosts` (`:11`), porque `.ngrok-free.app` ya lo cubre;
     - quitar `devServer.host`, que duplica `nuxt dev --host`.
  5. Probar el codemod oficial (`npx codemod@latest nuxt/4/migration-recipe`) y revisar el diff a mano.
  6. **Cambios de comportamiento de Nuxt 4 que no aplican aquí:** el repositorio no usa `useFetch` ni `useAsyncData` (0 usos; 21 archivos usan `$fetch`), así que los cambios de datos (`shallowRef`, `null` por defecto) no afectan.
  7. Probar `26.x` en los jobs de CI y en un preview aislado con el mismo lockfile. **Vercel** (manual): Project Settings → Node.js Version → 26.x tras validar CI y preview.
  8. **Tests:** `tests/*.mjs` importan TypeScript de `server/` con `jiti` a través de `nuxt/package.json`. Verificar que siguen funcionando con el `jiti` de Nuxt 4.
- **Terminado cuando:**
  - `pnpm build` y `pnpm test:agent` pasan;
  - las 21 páginas cargan en local sin errores en la consola;
  - el despliegue de preview en Vercel funciona.

### F1-T2 · Tailwind 4 + Nuxt UI 4 + VueUse (D29)

- **Objetivo:** instalar la librería de componentes y su Tailwind 4 **sin rediseñar** pantallas.
- **Archivos:**
  - `package.json`: quitar `@nuxtjs/tailwindcss`, `tailwindcss@3`, `autoprefixer` y `postcss`; agregar `@nuxt/ui` y `@vueuse/nuxt`;
  - `nuxt.config.ts`: `modules: ['@nuxt/ui', '@vueuse/nuxt']`;
  - `app/assets/css/main.css`;
  - `tailwind.config.ts`: se borra.
- **Pasos:**
  1. `main.css`: reemplazar `@tailwind base/components/utilities` (`:3-5`) por `@import "tailwindcss"; @import "@nuxt/ui";`.
  2. Pasar `tailwind.config.ts` a `@theme` en CSS:
     - colores `brand` (indigo) y `sand` (amber);
     - fuente `Plus Jakarta Sans`;
     - sombras `soft` y `card`;
     - radio `xl2`.
  3. Ejecutar `npx @tailwindcss/upgrade` para los renombres de clases de v4 (p. ej. `shadow-sm` → `shadow-xs`, `outline-none` → `outline-hidden`, el ancho por defecto de `ring`).
  4. Envolver `app.vue` en `<UApp>`. **No** reemplazar componentes existentes en esta tarea.
- **Terminado cuando:** las capturas de las 21 páginas, antes y después, no muestran diferencias relevantes. Se toman con Playwright; un script temporal basta si F1-T8 aún no existe.

### F1-T3 · Esqueleto de `layers/` y `shared/` (D36)

- **Objetivo:** crear la estructura final vacía para que todo código nuevo nazca en su lugar.
- **Archivos:**
  ```text
  layers/core/nuxt.config.ts                 (defineNuxtConfig({}))
  layers/core/app/                           (vacío; .gitkeep)
  layers/core/server/contexts/.gitkeep
  layers/core/server/shared/domain/tenant.ts (DEFAULT_TENANT_ID)
  layers/core/server/shared/infrastructure/.gitkeep
  layers/core/server/shared/http/.gitkeep
  shared/schemas/.gitkeep                    (esquemas zod compartidos, D31)
  tsconfig.json                              (no existe hoy; referencias a .nuxt/tsconfig.*.json de Nuxt 4)
  ```
- **Pasos:**
  1. `nuxt.config.ts`: `extends: ['./layers/core']` de forma **explícita**.
  2. Cuidado con `nitro.ignore: ['**/modules/**']` (`nuxt.config.ts:19`): hoy existe para que Nitro no tome `server/modules/` como módulos de Nitro, pero **también ignoraría `layers/modules/*/server`**. Cambiarlo a `['server/modules/**']` y comprobar que el build sigue sin intentar cargar `server/modules`.
  3. Cuidado con el **autoescaneo de `layers/`:** Nuxt 4 registra cada subcarpeta directa de `layers/` como capa. Las carpetas agrupadoras `layers/modules/` y `layers/verticals/` (sección 13) no son capas. Ver la nota en «Registro de cambios»: hace falta decidir antes de la Fase 8.
- **Terminado cuando:**
  - `pnpm build` pasa;
  - un endpoint de prueba en `layers/core/server/api/_health.get.ts` responde y se borra en el mismo PR.

### F1-T4 · Vitest en lugar de `node --test` (D24)

- **Objetivo:** un solo runner para los tests unitarios, de integración, de caracterización y de aislamiento.
- **Archivos:**
  - `package.json`: `vitest`, `@nuxt/test-utils`; scripts `test`, `test:unit` y `test:integration`; `test:agent` queda como alias;
  - `vitest.config.ts`: con `projects` `unit` e `integration`; alias de `h3` a `tests/stubs/h3.mjs`, como hoy;
  - los 5 archivos de `tests/` (`agent`, `sellerSessions`, `productSearch`, `contextSelection`, `salesSelector`).
- **Pasos:**
  1. Cambiar `node:test` por `vitest` (`test`, `describe`); `node:assert/strict` puede quedarse.
  2. Quitar el cargador `jiti` (`tests/agent.test.mjs:9-12`): Vitest importa TypeScript directamente.
  3. Mantener `--test-concurrency=1` como `fileParallelism: false`: los tests usan directorios temporales y almacenes de archivos.
  4. Crear `tests/unit/`, `tests/integration/`, `tests/characterization/` y `tests/isolation/` (sección 13 de la arquitectura).
- **Terminado cuando:** `pnpm test` ejecuta las mismas 243 pruebas en verde.

### F1-T5 · ESLint + vue-tsc + dependency-cruiser en CI (D25)

- **Objetivo:** que el CI bloquee el merge ante errores de tipos, de estilo y de capas.
- **Archivos:**
  - `package.json`: `@nuxt/eslint`, `eslint`, `vue-tsc`, `dependency-cruiser`; scripts `lint`, `typecheck` y `depcruise`;
  - `eslint.config.mjs`;
  - `.dependency-cruiser.cjs`;
  - `tsconfig.layers.json`;
  - `.github/workflows/ci.yml`.
- **Reglas de `dependency-cruiser`:** las de la sección 4 de la arquitectura.
  - `layers/*/server/contexts/*/domain` no importa nada fuera de `domain` y `shared/domain`.
  - `application` solo importa `domain` y sus `ports`.
  - Nada importa archivos internos de otro contexto, solo su `index.ts`.
  - `layers/core` no importa de `layers/modules` ni de `layers/verticals`.
- **Estrategia de tipos (el código actual tiene unos 780 `any`):**
  - **Estricto y bloqueante:** `vue-tsc -p tsconfig.layers.json` (solo `layers/**` y `shared/**`).
  - **Informativo:** `nuxi typecheck` del proyecto completo, sin bloquear, hasta la Fase 9.
  - **ESLint:** bloqueante en `layers/**` y `shared/**`; en el resto solo advierte.
- **CI:** al job `app` de `ci.yml` (hoy: install, build, `test:agent`, `:44-46`) agregar `lint`, `typecheck` y `depcruise`, y cambiar `test:agent` por `test`.
- **Terminado cuando:** un PR de prueba con `import` prohibido en `domain/` falla en CI.

### F1-T6 · Datos sintéticos: `supabase/seed.sql` (D43)

- **Objetivo:** datos fijos, sin clientes reales, para local, CI y staging.
- **Archivos:**
  - `supabase/seed.sql`;
  - `supabase/config.toml` (`[db.seed]`, `:60`, con `sql_paths = ['./seed.sql']`);
  - `scripts/db.sh`.
- **Contenido mínimo del seed:**
  - 3 usuarios (dueño, encargado, cajero) con contraseñas de prueba documentadas en el propio seed;
  - unidades y conversiones (unidad, docena, caja);
  - unos 30 productos con categorías, varias presentaciones y reglas de mayoreo, promoción y grupo de cliente;
  - 2 proveedores y compras que generen lotes FIFO con costos distintos;
  - 10 ventas, 1 pedido pendiente y 1 conteo de inventario;
  - 1 institución escolar con lista.
- **Pasos:**
  - `pnpm db:reset --empty` carga **solo** el seed.
  - `pnpm db:refresh` mantiene la copia de producción **solo en local**, nunca en CI ni en staging.
- **Terminado cuando:** `supabase db reset` con el seed deja una base con la que se puede vender, comprar y contar desde la app.

### F1-T7 · Entorno de staging (D43)

- **Objetivo:** ensayar migraciones y despliegues antes de producción.
- **Pasos manuales:**
  1. Crear el proyecto Supabase «papeleria-staging». El plan Free permite 2 proyectos.
  2. En Vercel: variables del entorno **Preview** apuntando a staging, con `APP_ENV=staging`. El guard de `server/utils/supabase.ts` ya acepta ese valor.
- **Archivos:**
  - `scripts/db.sh`: hoy solo maneja local y producción (`require_linked`). Agregar un destino `staging` a `pending` y `release` (por ejemplo `pnpm db:release staging`), aplicar el seed solo en staging y exigir publicar en staging antes que en producción.
  - `README.md`: actualizar la sección de entornos.
- **Terminado cuando:** una migración de prueba se publica en staging, el preview de Vercel la usa, y recién entonces se publica en producción.

### F1-T8 · Playwright: flujos principales

- **Objetivo:** ampliar los escenarios de F1-T0 y ejecutarlos con el seed completo también en staging.
- **Archivos:**
  - `playwright.config.ts`;
  - `tests/e2e/{login,sale,purchase,inventory}.spec.ts`;
  - `ci.yml`: job nuevo `e2e` con `supabase db start` + reset con seed, build, `nuxt preview` y Playwright.
- **Terminado cuando:** los escenarios de la línea base de F1-T0 y los recorridos de esta tarea pasan en CI con datos sintéticos.

### F1-T9 · Sentry (D22)

- **Archivos:**
  - `package.json` (`@sentry/nuxt`);
  - `sentry.client.config.ts` y `sentry.server.config.ts`;
  - `nuxt.config.ts`;
  - `.env.example` (`SENTRY_DSN`, `SENTRY_ENVIRONMENT`).
- **Pasos:**
  - Etiquetar cada evento con `tenant_id` (constante hasta la Fase 2), `user_id` y `role`.
  - `sendDefaultPii: false`: no enviar nombres de clientes ni cuerpos de petición.
  - Subir los source maps desde el build de Vercel.
- **Terminado cuando:** un error provocado en preview aparece en Sentry con entorno, usuario y negocio.

### F1-T10 · Renovate (D32)

- **Archivos:** `renovate.json`, con agrupación semanal, automerge solo de parches de dependencias de desarrollo y dependencias mayores agrupadas a mano.
- **Terminado cuando:** Renovate abre su PR de configuración inicial.

### F1-T11 · `AGENTS.md`, `CLAUDE.md` y plantillas

- **Objetivo:** que Claude y Codex sigan las mismas reglas (arquitectura §15).
- **Archivos:**
  - **ampliar** el `AGENTS.md` creado en F0-T0, que es la fuente única. `CLAUDE.md` sigue siendo `@AGENTS.md` y no se duplica contenido;
  - `docs/plantillas/` con plantillas de caso de uso, puerto, adaptador Drizzle, ruta con `defineApiHandler`, test unitario y test de caracterización.
- **Contenido de las guías:**
  - reglas de capas y dependencias;
  - código en inglés y documentos en español (D35, glosario §18.1);
  - dónde va cada cosa (sección 13);
  - comandos (`pnpm test`, `lint`, `typecheck`, `depcruise`, `db:*`);
  - nunca migraciones de Drizzle (D37);
  - nunca `number` para dinero (D38);
  - `pnpm db:backup` antes de cada migración en producción (D44);
  - un PR por tarea.
- **Terminado cuando:** un agente crea un caso de uso de ejemplo solo con estas guías y el CI pasa sin correcciones de forma.

### F1-T12 · `Money` y `Quantity` sobre big.js (D38)

- **Archivos:**
  - `layers/core/server/shared/domain/money.ts`, `quantity.ts` y sus tests;
  - `shared/schemas/money.ts` (zod: acepta cadena o número y lo convierte a `Money`).
- **Reglas:**
  - inmutables;
  - suma, resta y multiplicación por `Quantity`;
  - redondeo **por línea** a 2 decimales con `ROUND_HALF_UP`;
  - en F4 el cálculo por línea respeta si el precio del negocio incluye o excluye el impuesto;
  - comparación;
  - serialización a cadena para `numeric`;
  - `Quantity` con hasta 3 decimales (metros, kilos).
- **Terminado cuando:** los tests cubren `0.1 + 0.2`, el redondeo de IGV por línea frente a por total y las cantidades fraccionadas.

### F1-T13 · Guard global + `defineApiHandler` + permisos

- **Objetivo:** seguridad por defecto (arquitectura §10).
- **Archivos:**
  - `layers/core/server/middleware/guard.ts`;
  - `layers/core/server/shared/http/defineApiHandler.ts`;
  - `layers/core/server/shared/domain/permissions.ts` (matriz §10.1 como datos: `role → permission[]`);
  - `tests/unit/permissions.test.ts`.
- **Guard (`/api/**`):**
  - rechaza con 401 si no hay sesión, salvo una lista blanca explícita:
    - `/api/auth/sign-in` y `/api/auth/sign-out`;
    - `/api/agent/context`, `/api/agent/instructions` y `/api/agent/identification` (usan `requireAgentCredential`, `server/utils/agent.ts:29`);
    - `/api/agent/identification/lookup` y `/api/agent/identification/approve` (públicas por diseño, con límites propios);
  - usa el verificador de F0-T1a y conserva una sola identidad verificada por petición; carga en `event.context` el usuario, el rol (`getUserRole`) y `tenantId = DEFAULT_TENANT_ID`;
  - las rutas actuales conservan sus propias verificaciones; el guard es una capa adicional.
- **`defineApiHandler({ permission, body, query }, fn)`:**
  - exige el permiso;
  - valida con zod;
  - entrega `{ user, tenantId, permissions, uow }`;
  - traduce los errores de dominio a 400/403/404/409 sin exponer mensajes internos.
- **`event.context`:** se tipa con `declare module 'h3'` en `layers/core/server/shared/http/context.d.ts`. Eso reemplaza los 12 `(event.context as any)` de `server/utils/auth.ts`.
- **Terminado cuando:**
  - un test recorre **todas** las rutas de `server/api` y `layers/**/server/api` sin cookie y solo las de la lista blanca no responden 401;
  - el test vive en `tests/integration/guard.test.ts` y corre en CI.

### F1-T14 · Rol `app_backend` + Drizzle + `UnitOfWork` (D37)

- **Objetivo:** acceso transaccional a Postgres para el código nuevo.
- **Archivos:**
  - **Migración `crear_rol_app_backend`:**
    - `CREATE ROLE app_backend LOGIN NOBYPASSRLS NOINHERIT` (sin contraseña en la migración);
    - `GRANT USAGE ON SCHEMA public`;
    - SELECT, INSERT, UPDATE y DELETE sobre las tablas;
    - EXECUTE sobre las funciones;
    - **política temporal** `app_backend_all … TO app_backend USING (true) WITH CHECK (true)` en cada tabla con RLS. La Fase 2 la reemplaza por la condición de `tenant_id`.
  - `package.json`: `drizzle-orm`, `postgres`, `drizzle-kit` (dev); script `db:schema` = `drizzle-kit pull`.
  - `drizzle.config.ts`.
  - `layers/core/server/shared/infrastructure/db/schema.ts`, generado y **nunca** editado a mano.
  - `layers/core/server/shared/infrastructure/db/client.ts`: crear el cliente de `postgres.js` una vez por instancia, `prepare: false`, TLS en entornos remotos y límite inicial de una conexión por instancia. Medir esperas y conexiones con peticiones concurrentes en staging.
  - `layers/core/server/shared/infrastructure/unitOfWork.ts`.
- **`UnitOfWork.run(ctx, fn)`:**
  - abre una transacción;
  - ejecuta `set_config('app.tenant_id', …, true)` y `set_config('app.user_id', …, true)`;
  - el modo `db` sigue usando el JWT verificado y PostgREST según D46. En el modo Drizzle, los helpers obtienen el usuario de `app.user_id`;
  - confirma o revierte.
- **Conexión:**
  - producción y staging: Supavisor en modo transacción (puerto 6543), usuario `app_backend.<project-ref>`;
  - local: puerto directo 54322;
  - la contraseña se fija **a mano** en cada entorno (`ALTER ROLE app_backend PASSWORD …`) y va solo en `DATABASE_URL` de Vercel.
- **Terminado cuando:**
  - un test de integración ejecuta una transacción que escribe dos filas y falla a la mitad, y no queda ninguna;
  - con una política restrictiva de prueba, `app_backend` carece de `BYPASSRLS`, no es dueño de la tabla y no puede leer la fila excluida. Comprobar el resultado de la consulta bajo ese rol.

### F1-T15 · Outbox + despacho con `pg_cron` (D23)

- **Archivos:**
  - **Migración `outbox`:** tabla `outbox_events(id, tenant_id, type, payload jsonb, created_at, dispatched_at, attempts, last_error)`, con índice sobre los no despachados; extensiones `pg_cron` y `pg_net`; job cada minuto que hace `net.http_post` a `/api/internal/outbox/dispatch` con un secreto. La URL y el secreto van en `supabase_vault`, que ya está instalado.
  - `layers/core/server/shared/infrastructure/outbox.ts`: `EventPublisher` escribe dentro de la `UnitOfWork`.
  - `layers/core/server/api/internal/outbox/dispatch.post.ts`: en la lista blanca del guard, pero exige el secreto.
  - registro de suscriptores, vacío en esta fase.
- **Pasos:**
  - Despacho inmediato tras el commit, con `event.waitUntil`.
  - El barrido de `pg_cron` hace de respaldo.
  - Persistir entregas por `(event_id, subscriber_id)` con unicidad, intentos, último error y acuse. Reclamar entregas de forma atómica con recuperación de trabajos interrumpidos. Probar dos suscriptores, caída después del primer efecto y reintento sin duplicarlo. Alertar por pendientes cuya antigüedad supere el umbral operativo acordado.
  - Si el preview de Vercel tiene protección de despliegue, usar el token de bypass en staging.
- **Terminado cuando:** un evento confirmado llega a cada suscriptor y, ante reintentos, cada uno aplica sus efectos una sola vez. Un fallo de un suscriptor permite reintentar su entrega sin duplicar las demás. Una transacción revertida no publica eventos.

### F1-T16 · Pinia: sesión y módulos

- **Archivos:**
  - `package.json` (`pinia`, `@pinia/nuxt`);
  - `layers/core/app/stores/session.ts` (usuario, rol, permisos, `tenantId`);
  - `layers/core/app/stores/modules.ts` (vacío hasta la Fase 8);
  - `app/middleware/auth.global.ts` y `owner.ts`.
- **Pasos:**
  - Los middlewares llaman hoy a `/api/auth/me` en **cada** navegación. Pasan a cargar el store una vez y a decidir con `session.can(permission)`.
  - `/api/auth/me` (`server/api/auth/me.get.ts`) agrega `permissions` a la respuesta.
  - El menú de `app.vue` se filtra por permisos. Así se resuelve el ítem «Compra Escolar» visible para cajeros (Fase 0, F0-T6).
- **Terminado cuando:** se navega por la app con una sola llamada a `/api/auth/me` por carga, y el menú cambia según el rol.

### F1-T17 · Formato común

- **Archivos:**
  - `layers/core/app/utils/format.ts` (`formatMoney`, `formatNumber`, `formatDate` según `tenant_settings`; hasta la Fase 2, PEN y `America/Lima` como constantes);
  - `layers/core/server/shared/domain/num.ts` (`toNumber` para el código actual).
- **Pasos:**
  - Reemplazar las copias locales de formato de dinero en las 17 páginas y componentes que hoy usan `formatMoney`, `moneyFormatter` o `toFixed(2)`. Detectados con `grep` en `pages/` y `components/`; entre ellos `sales.vue`, `inventory.vue`, `utiles.vue` y `products.vue`.
  - Reemplazar las 12 copias de `toNumber` en el servidor (`suppliers/quotes/*` ×5, `reports/*-restock`, `school/stock-analysis`, `inventory/infra`, `reports/*`).
- **Terminado cuando:** `grep` no encuentra definiciones locales de esas funciones, y las capturas de Playwright no muestran cambios de formato salvo las unificaciones esperadas (p. ej. `S/ 1,234.50` en todas las páginas).

### F1-T18 · Borrar código muerto (arquitectura §16)

- **Archivos y objetos a borrar:**
  - **Archivos sueltos:**
    - `result.json`;
    - `data/` (23 archivos versionados, sin uso en scripts ni en el servidor);
    - `scripts/repair-uom-fifo.mjs`.
  - **Base de datos:** migración `borrar_tablas_legadas`, con `DROP TABLE` de `stg_productos_import`, `stg_compras_tania_import`, `stg_compras_ayrampo_import`, `import_batches` y `whatsapp_sessions` (y su trigger `trg_update_whatsapp_last_interaction`). **Antes:** `pnpm db:backup`.
- Proteger con el recorrido F1-T0 el reporte `/api/reports/executive-profitability`, su caso de uso y sus componentes `ExecutiveCompositionBar` y `ExecutiveTrendChart`.
- **Se conservan:** `match_products`, `image_cache`, `match_cache`, `analyzeImageCore` y `matchProductsCore`. Los usa `pages/utiles.vue` (lectura de listas por foto) y se reemplazan en la Fase 8.
- **Terminado cuando:** el build, los tests y Playwright pasan, y `pnpm db:reset` aplica limpio.

## 5. Cómo verificar

```bash
pnpm install && pnpm lint && pnpm typecheck && pnpm depcruise && pnpm test && pnpm build
```

```bash
pnpm db:reset --empty && pnpm exec playwright test
```

Además, en CI deben estar en verde los jobs `migraciones`, `app` y `e2e`.

## 6. Cómo volver atrás

- Cada tarea es un PR revertible con `git revert`.
- **F1-T1 y F1-T2** (framework) se revierten completas.
- **Migraciones (T14, T15, T18):** con una migración inversa en `supabase/rollbacks/`. El `DROP TABLE` de T18 solo se revierte restaurando desde el respaldo.
- **El guard (T13)** tiene un interruptor de emergencia (`GUARD_ENFORCE=false`) que lo deja en modo «solo registra». Se quita al terminar la fase.

## 7. Riesgos

| Riesgo | Mitigación |
|---|---|
| Regresiones visuales por Tailwind 4 | Capturas antes y después de las 21 páginas (F1-T2) |
| `nitro.ignore` y el autoescaneo de `layers/` cargan o ignoran carpetas de más | Pasos 2 y 3 de F1-T3; build y endpoint de prueba |
| El guard bloquea una ruta legítima | Test que recorre todas las rutas + interruptor de emergencia |
| Límite de conexiones del pooler en el plan Free | Modo transacción y `prepare: false`; monitorear en el panel de Supabase |
| `pg_net` no llega al preview de Vercel por la protección de despliegue | Token de bypass en staging; en producción, la ruta pública con secreto |
| Datos personales en Sentry | `sendDefaultPii: false`; no adjuntar cuerpos de petición |
| Mover carpetas rompe ramas abiertas | Requisito P2 |

## 8. Registro de cambios

| Fecha | Cambio |
|---|---|
| 2026-11-18 | Se adelanta la línea base, se programa la validación de Node 26 LTS y se precisan las garantías del guard, el pool y las entregas de eventos. |
| 2026-11-18 | Consolidación: D47 fija `DEFAULT_TENANT_ID`; D48 resuelve la estructura de Layers con `extends` explícito y la eliminación de `nitro.ignore: ['**/modules/**']`; el helper `requireRole` de F0-T9 se reemplaza por `defineApiHandler({ permission })`, que ya debe evaluar las concesiones por usuario cuando existan (D57, Fase 2); `scripts/db.sh` debe poder apuntar a staging (lo necesita la Fase 2). |
| 2026-11-18 | Documento inicial. **Pendientes para validar al iniciar:**<br>(a) La estructura `layers/modules/*` y `layers/verticals/*` de la arquitectura §13 choca con el autoescaneo de Nuxt 4, que solo registra subcarpetas directas de `layers/`, y con `nitro.ignore: ['**/modules/**']`. Opciones: `extends` explícito por cada módulo, o carpetas planas (`layers/mod-quotes`, `layers/vert-papeleria`). Decisión antes de la Fase 8.<br>(b) La política temporal `app_backend_all` de F1-T14 es amplia a propósito, porque no existe `tenant_id` hasta la Fase 2. |
