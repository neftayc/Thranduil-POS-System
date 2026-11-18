# Fase 0 — Seguridad urgente

> Estado: **Por validar al iniciar** · Detalle: completo (archivo por archivo) · Referencias verificadas contra el repositorio el 2026-11-18.

## 1. Objetivo y alcance

Cerrar las fallas críticas y altas de la auditoría (`docs/auditoria-2026-11-18.md`) que se pueden corregir **sin refactorizar**. Cada cambio es pequeño, local y reversible.

**Entra:**
- autenticación en `/api/school/*` (S1);
- eliminación del flujo de WhatsApp y del relé `send-message` (S2, S8, S9, D17);
- cierre del registro público y bloqueo del cambio de rol (S3);
- `requireOwner` en las APIs de reportes de solo-dueño (S4);
- endurecimiento de las tablas legadas y de las cachés de IA (S6, S7);
- autenticación en `products/search` (S10);
- un hallazgo nuevo (**S11**): un bypass de autenticación en `utiles/*`;
- un hallazgo nuevo (**S12**): acciones de escritura sin validación de rol (compras, productos, conteos, proveedores, precio en pedidos).

**No entra:**
- **S5 (RLS `*_all_auth`):** el backend actual escribe por PostgREST con el cliente de usuario, así que revocar ahora rompería ventas, compras e inventario. Se resuelve en la Fase 2, al revocar PostgREST y pasar al rol `app_backend`. **Riesgo residual:** un usuario autenticado que obtenga la anon key puede escribir directo por REST. La anon key no se envía al navegador hoy.
- Cambiar el cliente admin (service-role) de `/api/school/*` por el de usuario. Se hace al mover esas rutas al módulo `papeleria` (Fase 8).
- El guard global y `defineApiHandler`: son de la Fase 1. Aquí cada ruta se protege a mano, como hoy.

## 2. Requisitos previos

| # | Requisito | Quién |
|---|---|---|
| P1 | Trabajo sin commitear de `claude/db-entornos` ordenado (pendiente 1 de `arquitectura.md` §14) | Equipo |
| P2 | Ramas sin merge resueltas o, al menos, ninguna toca los archivos de esta fase | Equipo |
| P3 | `pnpm db:backup` de producción, hecho y guardado (D44) | Equipo |
| P4 | **Webhook de WhatsApp desactivado en Meta** (panel de la app → WhatsApp → Configuración → Webhook) antes de desplegar F0-T2 | Dueño de la cuenta de Meta |
| P5 | Supabase local funcionando (`pnpm db:start`, `pnpm db:reset`) para verificar las migraciones | Equipo |

## 4. Tareas en orden

Cada tarea = un PR. **F0-T0 va primero.** Las tareas 1 a 9 son independientes entre sí; el orden sugiere primero lo más grave.

### F0-T0 · Guía mínima para agentes de IA: `AGENTS.md` (Codex) y `CLAUDE.md` (Claude)

- **Objetivo:** que cualquier agente (Codex o Claude Code) que ejecute una tarea desde el primer PR tenga el contexto correcto. La guía completa, con reglas de capas, plantillas y comandos, llega en F1-T11; esta es la versión mínima.
- **Archivos (en la raíz del repositorio):**
  - `AGENTS.md`: fuente única del contenido. Codex lo lee automáticamente.
  - `CLAUDE.md`: una sola línea, `@AGENTS.md`. Claude Code importa el contenido de `AGENTS.md`, así no hay dos copias que mantener.
- **Contenido de `AGENTS.md`:**
  ```markdown
  # Guía para agentes

  Este repositorio se está refactorizando a una plataforma multi-negocio.
  Antes de cualquier cambio, lee:
  1. docs/arquitectura.md — decisiones (D1…), stack, permisos (§10.1), estructura.
  2. docs/fases/README.md — fase en curso y regla de validación de inicio.
  3. El documento de la fase en curso (docs/fases/fase-N-*.md).

  ## Reglas
  - Trabaja solo en la tarea asignada (F<fase>-T<n>); un PR por tarea.
  - Si el código real no coincide con el documento de la fase, detente y repórtalo:
    no improvises. Los cambios al plan se registran en «Registro de cambios».
  - No contradigas una decisión D… sin registrar antes una decisión nueva en
    docs/arquitectura.md (con aprobación del equipo).
  - Código en inglés; interfaz y documentos en español (D35).
  - Antes de una migración en producción: `pnpm db:backup` (D44).
  - Nunca: secretos en el código, desactivar RLS, usar service-role en rutas nuevas,
    commitear `.env*`.

  ## Comandos
  - `pnpm db:start`, `pnpm db:reset`: base local.
  - `pnpm build`, `pnpm test:agent`: build y tests (Vitest desde la Fase 1).
  ```
- **Terminado cuando:**
  - los dos archivos están en `main`;
  - Codex y Claude Code, al iniciar en el repositorio, mencionan la fase en curso cuando se les pregunta qué deben leer.

### F0-T1 · Autenticación en `/api/school/*` (S1)

- **Objetivo:** hoy ninguna de estas rutas valida la sesión y todas usan `getSupabaseAdminClient()` (salta RLS). Cualquiera en Internet puede crear, editar y borrar listas escolares.
- **Archivos:**
  - **Lectura y escritura:**
    - `server/api/school/institutions.ts` (GET, POST)
    - `server/api/school/grades.ts` (GET, POST)
    - `server/api/school/sections.ts` (GET, POST)
    - `server/api/school/lists.ts` (GET, POST, PATCH)
    - `server/api/school/list-items.ts` (POST y DELETE `:33`)
    - `server/api/school/item-brands.ts` (GET, POST y DELETE `:110`)
  - **Solo lectura:**
    - `server/api/school/all-lists-stock.get.ts`
    - `server/api/school/stock-analysis.get.ts`
    - `server/api/school/presentation-prices.get.ts`
- **Llamadas desde el frontend:** las de edición vienen de `pages/school-lists.vue`; las de análisis, de `pages/utiles.vue` (`:137`, `:151`, `:486`, `:571`, `:746-838`).
- **Pasos:**
  1. Al inicio de cada handler, `await requireAccessToken(event)` (de `server/utils/auth.ts`).
  2. En los métodos POST, PATCH y DELETE, además:
     ```ts
     const role = await getUserRole(event)
     if (!['owner', 'manager'].includes(role)) throw createError({ statusCode: 403, statusMessage: 'Acceso denegado' })
     ```
     Así queda alineado con la matriz §10.1 (`products.edit`: dueño y encargado).
  3. **No** cambiar el cliente admin en esta fase.
- **Terminado cuando:**
  - sin cookie, todas las rutas responden 401;
  - un cajero recibe 403 en POST, PATCH y DELETE y 200 en GET;
  - `school-lists.vue` y `utiles.vue` funcionan igual con un dueño.

### F0-T2 · Eliminar el flujo de WhatsApp y el relé de mensajes (S2, S8, S9, D17)

- **Objetivo:** `send-message` envía cualquier texto a cualquier número desde la cuenta de WhatsApp Business sin autenticación. El webhook acepta mensajes sin firma y crea pedidos. Ningún archivo del frontend llama a estas rutas (verificado con `grep`).
- **Archivos a borrar:**
  - **Rutas:**
    - `server/api/webhook/send-message.post.ts`
    - `server/api/webhook/whatsapp.get.ts` (verify token con valor por defecto fijo en `:10`)
    - `server/api/webhook/whatsapp.post.ts`
    - `server/api/webhook/notify-order-ready.post.ts`
    - `server/api/utiles/modify-cart.post.ts` (sin llamadas desde el frontend)
    - `server/api/utiles/embed-catalog.post.ts` (sin llamadas desde el frontend; el script `scripts/embed-catalog.mjs` **se conserva** porque mantiene los embeddings de `match_products`, que usa `utiles/match`)
  - **Utilidades:**
    - `server/utils/whatsappFormatter.ts`
    - `server/utils/whatsappMedia.ts`
    - `server/utils/transcribeAudio.ts`
    - `server/utils/schoolList.ts` (solo lo importaba `whatsapp.post.ts`)
- **Archivos a editar:**
  - `server/utils/aiLogic.ts`: borrar `modifyCartCore` (`:361`) y `createSalesOrderFromWhatsApp` (`:534`), que quedan sin uso. **Conservar** `analyzeImageCore` y `matchProductsCore`, que usa `pages/utiles.vue`.
  - `package.json`: quitar `form-data` y `@types/form-data` (solo los usaba `transcribeAudio.ts:2`).
  - `.env.example`: quitar `WHATSAPP_*`.
  - `pages/sales.vue`: quitar la función de notificar al cliente `handleNotifyFileChange` (`:2105`, llama a `/api/webhook/notify-order-ready` en `:2119`), su `activeNotifyOrderId`, el `<input type="file">` y el botón que la abren en la vista de pedidos. **Corrección:** el objetivo de esta tarea decía que ningún archivo del frontend llamaba a estas rutas; esta sí.
- **Pasos manuales:**
  - P4 (webhook desactivado en Meta) **antes** de desplegar.
  - Borrar las variables `WHATSAPP_*` en Vercel.
- **Fuera de esta tarea:** la tabla `whatsapp_sessions` (solo service-role tiene acceso) se borra en la Fase 1 (F1-T18).
- **Terminado cuando:**
  - las cuatro rutas de webhook responden 404;
  - `pnpm build` y `pnpm test:agent` pasan;
  - `grep -r "whatsapp" server` no devuelve código vivo, salvo comentarios.

### F0-T3 · Quitar el bypass `x-webhook-token` en `utiles/*` (S11, hallazgo nuevo)

- **Objetivo:** `server/api/utiles/analyze-image.post.ts:5-17` y `server/api/utiles/match.post.ts:5-17` aceptan **cualquier** valor en el header `x-webhook-token` (o un `Authorization: Bearer` arbitrario) en lugar de la sesión. Con un token inválido la consulta a Supabase falla, pero la llamada a OpenAI puede ejecutarse igual. Eso es **gasto de IA sin autenticación**. El único que usaba ese header era el webhook borrado en F0-T2.
- **Archivos:** los dos anteriores.
- **Pasos:** reemplazar el bloque `authHeader` / `internalToken` por `const token = await requireAccessToken(event)`.
- **Terminado cuando:**
  - `curl -X POST -H 'x-webhook-token: x' …/api/utiles/match` responde 401;
  - `pages/utiles.vue` sigue analizando fotos y emparejando productos con sesión.

### F0-T4 · Cerrar el registro público (S3, parte 1)

- **Objetivo:** hoy cualquiera puede registrarse y queda como `cashier` (`handle_new_user`, `baseline.sql:841`). Los usuarios ya se crean desde `/api/admin/create-user`, que usa `auth.admin.createUser` (`server/modules/admin/infra/supabaseAdminRepository.ts:46`) y **no** se ve afectado por desactivar el registro.
- **Archivos:**
  - **Borrar:** `server/api/auth/sign-up.post.ts` y `server/modules/auth/app/signUp.ts`.
  - `server/modules/auth/infra/supabaseAuthRepository.ts:34`: quitar el método `signUp`, su firma en `server/modules/auth/ports.ts:26` y el tipo `SignUpResult` (`:18`).
  - `pages/login.vue`: quitar `isSignUp` (`:7`), la rama de registro (`:15-25`), el campo de nombre (`:79-82`) y el botón «Crear cuenta» (`:98-100`).
  - `supabase/config.toml`: `enable_signup = false` en `[auth]` (`:165`) y en `[auth.email]` (`:200`).
- **Paso manual en producción:** Supabase → Authentication → Sign In / Providers → desactivar «Allow new users to sign up».
- **Terminado cuando:**
  - `POST /api/auth/sign-up` responde 404;
  - en producción, `POST {SUPABASE_URL}/auth/v1/signup` con la anon key responde «Signups not allowed»;
  - el dueño sigue creando usuarios desde `/users`.

### F0-T5 · Bloquear el cambio de rol propio (S3, parte 2)

- **Objetivo:** la política `profiles_update_own` (`baseline.sql:4015`) deja que cada usuario haga UPDATE de su fila, **incluida la columna `role`**, y `GRANT ALL ON profiles TO authenticated/anon` (`:5594-5595`) lo permite. Hoy ningún código actualiza `profiles` con el cliente de usuario: los cambios de rol y nombre pasan por el cliente admin (`supabaseAdminRepository.ts:59` y `:78`).
- **Archivos:**
  - nueva migración: `pnpm db:new bloquear_cambio_de_rol`;
  - rollback en `supabase/rollbacks/<timestamp>_bloquear_cambio_de_rol_down.sql`, siguiendo la convención existente.
- **SQL:**
  ```sql
  DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
  REVOKE INSERT, UPDATE, DELETE ON public.profiles FROM anon, authenticated;
  ```
  Se revoca la tabla completa y no solo la columna, porque un `GRANT` a nivel de tabla cubre todas las columnas y el `REVOKE UPDATE (role)` no tendría efecto.
- **Terminado cuando:** en local, como `authenticated`, el UPDATE falla con «permission denied»:
  ```sql
  begin;
  set local role authenticated;
  select set_config('request.jwt.claims', '{"sub":"<uid-cajero>","role":"authenticated"}', true);
  update public.profiles set role = 'owner' where id = '<uid-cajero>';
  rollback;
  ```
  Además, desde `/users` el dueño sigue cambiando roles.

### F0-T6 · Reportes de solo-dueño protegidos en el servidor (S4)

- **Objetivo:** las páginas de reportes usan `middleware: ['owner']`, pero sus APIs aceptan cualquier sesión (`requireAccessToken`).
  - **Ya correcto (verificado):** `maintenance*`, `pricing/*` y `admin/*` usan `requireOwner`; `agent/sessions*` exige dueño o encargado.
- **Archivos:**

  | Ruta | Página que la llama | Cambio |
  |---|---|---|
  | `server/api/reports/financial-summary.get.ts:19` | `financial-summary.vue` (owner) | `requireOwner` |
  | `server/api/reports/product-profitability.get.ts:19` | `product-profitability.vue` (owner) | `requireOwner` |
  | `server/api/reports/executive-investment.get.ts:24` | `executive-profitability.vue` (owner) | `requireOwner` |
  | `server/api/reports/executive-profitability.get.ts` | ninguna (reemplazada) | **borrar** (su módulo se borra en F1-T18) |
  | `server/api/reports/sales-restock.get.ts:112` | `components/stock-ai/SalesSuggestedView.vue:351` | dueño o encargado (`purchases.register`) |
  | `server/api/reports/school-restock.get.ts:118` | `pages/stock-ai.vue:372` | dueño o encargado |

- **Pasos:** sustituir `requireAccessToken(event)` por `requireOwner(event)`, que devuelve `accessToken`. En los dos de reposición, `getUserRole` + 403 si no es `owner` ni `manager`.
- **Cambio visible:** un cajero ya no puede ver «Compra Escolar» (`/stock-ai`). Hay que ocultar el ítem del menú para cajeros en `app.vue:47`, o aceptar el 403 hasta la Fase 1, cuando el menú se arma con permisos.
- **Terminado cuando:**
  - con la cookie de un cajero, las 5 rutas responden 403;
  - con la de un encargado, `sales-restock` y `school-restock` responden 200;
  - con la del dueño, todas responden 200.

### F0-T7 · Tablas legadas y cachés de IA (S6, S7)

- **Objetivo:**
  - `stg_productos_import`, `stg_compras_tania_import`, `stg_compras_ayrampo_import` e `import_batches` no tienen RLS y tienen `GRANT ALL` a `anon` (p. ej. `baseline.sql:5462`, `:5648`). Ningún código las usa (verificado).
  - `image_cache` y `match_cache` permiten INSERT, SELECT y UPDATE a **cualquier rol**, incluido `anon` (`baseline.sql:3768-3788`).
- **Archivos:** migración `pnpm db:new endurecer_tablas_legadas` + rollback.
- **SQL:**
  ```sql
  -- Tablas de importaciones pasadas: sin acceso por API (se borran en F1-T18).
  ALTER TABLE public.stg_productos_import ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.stg_compras_tania_import ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.stg_compras_ayrampo_import ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.import_batches ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON public.stg_productos_import, public.stg_compras_tania_import,
    public.stg_compras_ayrampo_import, public.import_batches FROM anon, authenticated;

  -- Cachés de IA: solo usuarios autenticados (utiles usa el cliente de usuario).
  DROP POLICY "Allow insert for all users" ON public.image_cache;
  DROP POLICY "Allow read for all users"   ON public.image_cache;
  DROP POLICY "Allow update for all users" ON public.image_cache;
  DROP POLICY "Allow insert for all users" ON public.match_cache;
  DROP POLICY "Allow read for all users"   ON public.match_cache;
  DROP POLICY "Allow update for all users" ON public.match_cache;
  CREATE POLICY image_cache_auth ON public.image_cache TO authenticated USING (true) WITH CHECK (true);
  CREATE POLICY match_cache_auth ON public.match_cache TO authenticated USING (true) WITH CHECK (true);
  REVOKE ALL ON public.image_cache, public.match_cache FROM anon;
  ```
- **Terminado cuando:**
  - `pnpm db:reset` aplica limpio y el CI (`supabase db lint`) pasa;
  - con la anon key, `GET /rest/v1/stg_productos_import` y `GET /rest/v1/image_cache` devuelven error o una lista vacía;
  - `utiles` sigue usando la caché.

### F0-T8 · Autenticación en `products/search` (S10)

- **Objetivo:** `server/api/products/search.get.ts` no valida la sesión y usa `getSupabaseAdminClient()` (`:20`). Expone el catálogo con precios y stock. La llaman `pages/utiles.vue` y `pages/school-lists.vue`.
- **Pasos:** `const token = await requireAccessToken(event)` y `getSupabaseUserClient(token)`. La política `products_all_auth` ya permite SELECT a usuarios autenticados.
- **Terminado cuando:** sin cookie responde 401; con sesión, los resultados son los mismos que antes.

### F0-T9 · Permisos por rol en las acciones de escritura (S12, hallazgo nuevo)

- **Objetivo:** al detallar las fases se encontró que varias acciones de escritura solo exigen sesión (`requireAccessToken`), y que sus funciones de BD tampoco validan el rol (solo `auth.uid()`). Cualquier cajero, y antes de F0-T4 cualquier usuario autoregistrado, puede registrar compras, editar productos y stock, o aplicar conteos. Se revisaron **todas** las rutas de escritura de `server/api` contra la matriz §10.1.
- **Acciones a corregir:**

  | Acción | Rutas | Función de BD | Permiso §10.1 | Quién podrá |
  |---|---|---|---|---|
  | Registrar y corregir compras | `purchases/create.post.ts`, `purchases/items.patch.ts` | `create_purchase` | `purchases.register` | dueño, encargado |
  | Crear y editar productos (incluye fijar stock y costo) | `products/catalog-upsert.post.ts`, `products/conversions-replace.post.ts` | `upsert_product_catalog`, `replace_product_unit_conversions` | `products.edit` | dueño, encargado |
  | Aplicar y cerrar conteos | `inventory/apply.post.ts`, `inventory/close.post.ts` | (TS directo) | `inventory.apply` | dueño, encargado |
  | Proveedores y cotizaciones de proveedor | `suppliers/save.post.ts`, `suppliers/quotes/create.post.ts`, `suppliers/quotes/[id].patch.ts`, `suppliers/quotes/[id]/items.post.ts`, `suppliers/quotes/[id]/items/[itemId].delete.ts` | — | `suppliers.edit` / `purchases.register` | dueño, encargado |
  | **Precio en pedidos** | `sales/hold.post.ts` | `create_sales_order` | `sales.manual_discount` | dueño, encargado (y, desde la Fase 2, usuarios con el permiso concedido: D57) |

- **Ya correctas (verificado):** `admin/*`, `maintenance/*`, `pricing/*` (dueño); `agent/sessions/revoke` (dueño o encargado); `sales/create-sale` (la RPC `create_sale` valida rol para descuento, venta a nombre de otro y aprobación); `customers/save` e `inventory/start` (todos los roles, según la matriz); `combos/plans.put` (planificador propio del usuario); `products/verify-brand` (solo lectura).
- **Pasos:**
  1. **Rutas:** un helper temporal `requireRole(event, ['owner','manager'])` en `server/utils/auth.ts`, usado en las rutas de la tabla. Lo reemplaza `defineApiHandler({ permission })` en la Fase 1.
  2. **BD** (migración `pnpm db:new permisos_en_funciones` + rollback), por defensa en profundidad, ya que hoy se puede llamar a las RPC directo con la anon key:
     - `create_purchase`, `upsert_product_catalog`, `replace_product_unit_conversions`: al inicio, `if public.user_role() not in ('owner','manager') then raise exception 'Tu rol no permite …'; end if;`.
     - `create_sales_order`: aplicar a `price_unit` la misma regla que `create_sale`. Si el precio enviado difiere del que resuelve `resolve_sale_item_pricing`, se exige rol `owner`/`manager` y un motivo. Si no, se usa el precio resuelto.
  3. **UI:** ocultar o deshabilitar para el cajero los botones de compra, de edición de producto y de aplicar conteo (`pages/purchases.vue`, `pages/products.vue`, `pages/inventory.vue`, `pages/supplier-quotes.vue`), para que no vea un 403.
- **Terminado cuando:**
  - con la cookie de un cajero, las rutas de la tabla responden 403;
  - con la de un encargado, responden 200;
  - en local, llamar a `create_purchase` como cajero por `rpc` falla;
  - un cajero que envía un `price_unit` distinto al resuelto en `sales/hold` recibe error, y uno que envía el precio resuelto puede crear el pedido;
  - el POS del cajero sigue vendiendo y creando pedidos normales.

### F0-T10 · Verificación integral y despliegue

- **Objetivo:** confirmar que no quedó ninguna ruta abierta y publicar.
- **Pasos:**
  1. Script ad hoc con `curl`, sin cookie, a cada ruta de `server/api`. Solo deben responder distinto de 401/404:
     - `auth/sign-in` y `auth/sign-out`;
     - `agent/identification/lookup` y `agent/identification/approve` (devuelven 415/400 sin cuerpo JSON válido);
     - `agent/context`, `agent/instructions` y `agent/identification` (devuelven 401 o 503 por el token del conector).
  2. Matriz de roles: crear en local un cajero y un encargado con `/api/admin/create-user` y repetir las pruebas de T1, T5, T6 y T9 con `curl -c/-b` (cookie jar tras `POST /api/auth/sign-in`).
  3. `pnpm db:backup` y luego `pnpm db:release`, que publica primero las migraciones y después `main` → Vercel.
  4. Repetir el paso 1 contra producción.
- **Terminado cuando:** las pruebas anteriores se cumplen en producción y queda anotado el resultado en «Registro de cambios».

## 5. Cómo verificar

```bash
pnpm db:reset && pnpm build && pnpm test:agent
```

```bash
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3000/api/school/institutions"   # 401
```

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST "http://localhost:3000/api/webhook/send-message"   # 404
```

```bash
curl -s -c /tmp/caj.txt -H 'content-type: application/json' -d '{"email":"cajero@test.local","password":"…"}' http://localhost:3000/api/auth/sign-in
```

```bash
curl -s -o /dev/null -w "%{http_code}\n" -b /tmp/caj.txt "http://localhost:3000/api/reports/financial-summary"   # 403
```

## 6. Cómo volver atrás

- **Código:** cada tarea es un PR; se revierte con `git revert <merge>` y se vuelve a publicar.
- **Migraciones (T5, T7):** se aplica el SQL de `supabase/rollbacks/…_down.sql` en una migración nueva (no se edita la migración publicada).
  - El rollback de T5 recrea `profiles_update_own` y el GRANT, pero **no se recomienda**: reabre S3.
- **WhatsApp:** reactivarlo exige restaurar los archivos desde git y el webhook en Meta. Por D17, no se planea.
- **Registro público:** reactivar la opción en Supabase y revertir T4.

## 7. Riesgos

| Riesgo | Mitigación |
|---|---|
| Un cajero pierde acceso a `/stock-ai` (T6) | Es intencional según la matriz §10.1; ocultar el menú o avisar al equipo |
| Un encargado o cajero editaba listas escolares | Tras T1 solo dueño y encargado pueden escribir; confirmar con el negocio |
| Algún cliente seguía escribiendo por WhatsApp | P4 + aviso a clientes; el canal vuelve como parte del agente (D17) |
| Un usuario sin cuenta no puede registrarse | Es el comportamiento deseado (D14); el dueño crea los usuarios |
| S5 sigue abierto hasta la Fase 2 | La anon key no sale del servidor; no publicarla en ningún cliente ni repositorio |

## 8. Registro de cambios

| Fecha | Cambio |
|---|---|
| 2026-11-18 | Se agrega **F0-T0**: guía mínima para agentes, con `AGENTS.md` (Codex) como fuente y `CLAUDE.md` que lo importa con `@AGENTS.md`. Pedido del usuario. |
| 2026-11-18 | Consolidación: se agrega **F0-T9 (S12)** tras revisar todas las rutas de escritura contra la matriz §10.1 (decisión del usuario: corregir compras sin rol y cualquier acción con el mismo problema; el precio en pedidos solo para usuarios con permiso). F0-T2 ahora también quita la llamada a `notify-order-ready` desde `pages/sales.vue:2119`. La verificación pasa a F0-T10. |
| 2026-11-18 | Documento inicial. Hallazgos al verificar: S4 era menor de lo indicado en la auditoría (`pricing/*` y `maintenance*` ya usan `requireOwner`); se agrega **S11** (bypass `x-webhook-token` en `utiles/*`). |
