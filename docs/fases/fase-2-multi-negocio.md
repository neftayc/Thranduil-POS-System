# Fase 2 — Multi-negocio

> **Estado:** Por validar al iniciar · **Detalle:** completo (tablas, datos, RLS).
> Referencias de [`../arquitectura.md`](../arquitectura.md): §5.2, §6.3, §6.4, §7, §10 y D4, D7, D20, D21, D37, D42–D45.
> Las referencias a `baseline.sql` apuntan a `supabase/migrations/20261116120000_baseline.sql` al 2026-11-18.

## 1. Objetivo y alcance

Convertir la base de datos en **multi-negocio**:
- toda tabla de negocio lleva `tenant_id`;
- RLS aísla por negocio;
- los roles pasan a ser por negocio (`memberships`);
- la papelería queda migrada como **negocio #1**, sin pérdida de datos y sin cambios visibles para sus usuarios.

**Entra:**
- tablas de plataforma (`tenants`, `memberships`, `tenant_settings`, `tenant_modules`, `locations`, `platform_admins`, `platform_config`);
- `tenant_id` en todas las tablas de negocio y restricciones únicas y FK que lo incluyen;
- RLS reescrita;
- hook de token de Supabase Auth;
- migración de datos;
- borrado de tablas obsoletas;
- test de aislamiento;
- ventana de mantenimiento (D21).

**No entra (y en qué fase va):**

| Tema | Fase |
|---|---|
| `location_id` en stock, FIFO y movimientos | F5. Aquí solo se crea la ubicación #1, así no se toca dos veces el FIFO en PL/pgSQL |
| `document_series` (D42) | F6. Nace junto con el documento de venta; crearla ahora sería diseñarla sin su modelo |
| Revocar los permisos de `authenticated` sobre las tablas | Al terminar F7 (ver §1.1) |
| Prefijos `pap_` de las tablas escolares | F8 |
| Alta de un segundo negocio | Prohibida hasta cumplir la puerta de §1.2 |

### 1.1 La tensión PostgREST ↔ multi-negocio (leer antes de empezar)

Hasta que las Fases 3 a 7 reemplacen el acceso a datos, casi todo el servidor sigue usando **supabase-js / PostgREST** con el JWT del usuario. Por ejemplo, los `server/modules/*/infra/supabase*Repository.ts` y las RPC `create_sale`, `create_purchase`, `pay_sales_order`, etc.

PostgREST **no puede ejecutar `set_config('app.tenant_id')`** por petición. Tampoco se pueden revocar sus permisos en esta fase, porque el sistema dejaría de funcionar. Por eso el negocio debe llegar a la BD por dos caminos, y RLS acepta ambos:

| Camino | Quién lo usa | Cómo llega el negocio |
|---|---|---|
| **JWT** | supabase-js con token de usuario: repositorios actuales, RPC y el vendedor del agente | Claim `tenant_id`, inyectado por un **Custom Access Token Hook** de Supabase Auth a partir de la membresía por defecto del usuario |
| **`set_config`** | Drizzle con el rol `app_backend` (F1, `UnitOfWork`) | `set_config('app.tenant_id', …, true)` en cada transacción |

`public.current_tenant()` lee primero `app.tenant_id` y, si no existe, el claim del JWT. **Con esto no hay que revocar PostgREST en F2.** Solo se revoca `anon`, que tras la Fase 0 no lee tablas: solo usa la API de Auth. La revocación de `authenticated` se hace cuando ya no quede ningún acceso a datos por supabase-js, al cierre de F7.

**Riesgos que este camino deja abiertos, aceptables solo con un único negocio:**
1. Las rutas con **service-role** (cliente admin) se saltan RLS y no envían JWT:
   - `server/api/school/*`
   - `server/api/products/search.get.ts`
   - `server/api/reports/sales-restock.get.ts` y `school-restock.get.ts`
   - `server/api/utiles/embed-catalog.post.ts`
   - `server/api/webhook/notify-order-ready.post.ts` (si sobrevive a la Fase 0)
   - `server/modules/agent/infra/supabaseAgentCatalog.ts`
   - `supabaseSellerAuth.ts`
   - `supabaseAdminRepository.ts`

   Sus inserciones obtienen el negocio por el *fallback* de negocio único (§4, F2-T2).
2. Las funciones de negocio **`SECURITY DEFINER`** (`create_sale`, `create_purchase`, `create_sales_order`, `pay_sales_order`, `upsert_product_catalog`, `replace_product_unit_conversions`, `resolve_sale_item_pricing`…) se saltan RLS. Hoy leen por `id` sin filtrar por negocio. Las FK compuestas de §4 impiden que *escriban* referencias cruzadas, pero no que *lean* datos de otro negocio. Estas funciones se reemplazan en F3–F6.

### 1.2 Puerta para el segundo negocio

Se verifica al final de F6 y queda registrada aquí. No se da de alta un segundo negocio hasta que se cumpla todo esto:
- [ ] Ninguna ruta usa service-role para datos de negocio. Lo filtran explícitamente por negocio o usan el camino `app_backend`.
- [ ] No queda ninguna función de negocio `SECURITY DEFINER`. Solo las de búsqueda (§4), que filtran por negocio.
- [ ] Se eliminó el *fallback* de negocio único (`platform_config.single_tenant_mode = false` y DEFAULT sin respaldo).
- [ ] Se activó el selector de negocio para usuarios con varias membresías.
- [ ] D44: Vercel Pro, Supabase Pro y PITR activos.

## 2. Requisitos previos

- **Fase 0 terminada.** Registro público cerrado (`profiles_update_own` ya no permite cambiar `role`). Webhook de WhatsApp desactivado (D17). Los `stg_*` y las cachés quedan con RLS o borrados.
- **Fase 1 terminada:**
  - Nuxt 4;
  - rol `app_backend` (NOBYPASSRLS) + Drizzle + `UnitOfWork` con `set_config('app.tenant_id' | 'app.user_id')`;
  - guard + `defineApiHandler`;
  - Vitest;
  - `supabase/seed.sql`;
  - **staging operativo (D43)**, con `scripts/db.sh` capaz de apuntar a staging.
- Ensayo completo de esta fase en staging, con una copia del esquema y datos sintéticos de volumen parecido al real.
- Ventana de mantenimiento acordada con la papelería (D21). La duración estimada sale del ensayo.

## 4. Tareas en orden

**Despliegue de la fase:**
- **F2-T1 a F2-T3** son **aditivas**: no cambian el comportamiento y se despliegan antes de la ventana.
- **F2-T4 a F2-T7** se aplican **dentro de la ventana**.
- **F2-T8 a F2-T10** van después.

---

### F2-T1 · Datos de prueba de dos negocios

- **Objetivo:** que los tests y staging tengan siempre al menos dos negocios.
- **Archivos:** `supabase/seed.sql`.
- **Pasos:** sembrar el negocio A (papelería sintética) y el B (ferretería sintética), cada uno con:
  - 2 usuarios (dueño y cajero) y 1 usuario con membresía en ambos;
  - productos con el **mismo `sku`** en A y B;
  - categorías, unidades, métodos de pago y grupos de cliente con los **mismos `code`**;
  - una compra, una venta, un pedido y un conteo.

  El seed se escribe contra el esquema final de F2 y se activa junto con F2-T4.
- **Terminado:** `pnpm db:reset` deja ambos negocios cargados, sin errores.

---

### F2-T2 · Migración A: tablas y funciones de plataforma (aditiva)

- **Objetivo:** crear la estructura de plataforma y el negocio #1 sin tocar las tablas existentes.
- **Archivos:** `supabase/migrations/<ts>_platform_tenancy.sql`; `supabase/rollbacks/<ts>_platform_tenancy_down.sql`.

**Tablas:**

```sql
tenants (
  id uuid PK DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,               -- 'papeleria-kuska'; futuro subdominio
  name text NOT NULL,
  business_type text NOT NULL,             -- 'papeleria' | 'ferreteria' | 'taller' | …
  plan text NOT NULL DEFAULT 'free',       -- D15
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id)
)

memberships (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','manager','cashier')),   -- matriz §10.1
  is_default boolean NOT NULL DEFAULT false,   -- negocio del claim del JWT
  active boolean NOT NULL DEFAULT true,
  invited_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
)
-- UNIQUE (user_id) WHERE is_default  ·  INDEX (user_id)

tenant_settings (
  tenant_id uuid PK REFERENCES tenants(id) ON DELETE CASCADE,
  currency text NOT NULL DEFAULT 'PEN',            -- D13
  timezone text NOT NULL DEFAULT 'America/Lima',
  locale text NOT NULL DEFAULT 'es-PE',
  default_tax_rate numeric(6,4) NOT NULL DEFAULT 0.18,   -- D9
  price_includes_tax boolean NOT NULL DEFAULT true,      -- D9
  money_decimals smallint NOT NULL DEFAULT 2,
  quantity_decimals smallint NOT NULL DEFAULT 3,         -- D38
  updated_at timestamptz NOT NULL DEFAULT now()
)

tenant_modules (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  module_id text NOT NULL,                 -- 'papeleria' | 'kits' | 'agent' | …
  enabled boolean NOT NULL DEFAULT true,
  config jsonb NOT NULL DEFAULT '{}',
  enabled_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, module_id)
)

locations (                                -- D7; F5 le cuelga el stock
  id uuid PK DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'store' CHECK (kind IN ('store','warehouse')),
  is_default boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
)
-- UNIQUE (tenant_id) WHERE is_default

platform_admins (user_id uuid PK REFERENCES auth.users(id), created_at timestamptz DEFAULT now())  -- §7.3

platform_config (                          -- fila única; se elimina en la puerta §1.2
  id boolean PK DEFAULT true CHECK (id),
  single_tenant_mode boolean NOT NULL DEFAULT true,
  fallback_tenant_id uuid REFERENCES tenants(id)
)
```

**Funciones** (`STABLE`, `search_path` fijo y `GRANT EXECUTE` solo a `authenticated` y `app_backend`):

| Función | Hace |
|---|---|
| `current_tenant()` | `coalesce(nullif(current_setting('app.tenant_id', true),'')::uuid, nullif(auth.jwt()->>'tenant_id','')::uuid)`. **Estricta, sin respaldo: es la que usa RLS** |
| `current_app_user()` | `coalesce(nullif(current_setting('app.user_id', true),'')::uuid, auth.uid())` |
| `has_tenant_role(roles text[])` | `EXISTS` en `memberships` con `tenant_id = current_tenant()`, `user_id = current_app_user()`, `active` y `role = ANY(roles)`. `SECURITY DEFINER`, solo lectura |
| `tenant_for_insert()` | `coalesce(current_tenant(), <fallback_tenant_id si single_tenant_mode>)`. Si sigue en NULL lanza error. **Solo para DEFAULT de columnas** |
| `user_role()` | Reescrita: devuelve el rol del usuario **en el negocio actual**. Mantiene la firma; la usan `server/utils/auth.ts:130`, `supabaseAuthRepository.ts:59` y `supabaseSellerAuth.ts:30` |
| `is_owner()` | Reescrita: `has_tenant_role('{owner}')`. Mantiene la firma; la usan 22 políticas actuales |
| `custom_access_token_hook(event jsonb)` | Agrega los claims `tenant_id` (membresía `is_default`, o la única que tenga) y `tenant_role`. `GRANT EXECUTE` solo a `supabase_auth_admin`; `supabase_auth_admin` recibe `SELECT` sobre `memberships` |

**Datos:**
1. Insertar el negocio #1 (papelería, `business_type='papeleria'`).
2. Crear su `tenant_settings` con los valores por defecto.
3. Activar los módulos `papeleria`, `kits` y `agent`.
4. Crear la ubicación «Tienda» (`is_default`).
5. Crear `platform_config` (`single_tenant_mode=true`, `fallback_tenant_id` = negocio #1).
6. Crear `memberships` desde `profiles`: `role` = `profiles.role`, `is_default=true`.
7. Agregar como `platform_admins` a los dueños actuales.

**Supabase Auth:**
- Local: habilitar `[auth.hook.custom_access_token]` en `supabase/config.toml`.
- Producción: el hook se activa desde el panel **en la ventana** (F2-T6), no antes.

**Terminado:** `pnpm db:reset` aplica todo. Las funciones devuelven el negocio #1 para un JWT con claim. El sistema sigue funcionando igual porque nada usa todavía estas tablas.

---

### F2-T3 · Código de aplicación compatible (aditivo)

- **Objetivo:** que el servidor ya entienda negocios antes de la ventana.
- **Archivos:**
  - `server/utils/auth.ts` (o su sucesor de F1 en `layers/core/server/shared/infrastructure/auth`);
  - el guard de F1;
  - `server/modules/admin/infra/supabaseAdminRepository.ts`;
  - `server/modules/agent/infra/supabaseSellerAuth.ts` (solo verificar).
- **Pasos:**
  1. **Token sin claim `tenant_id` = token vencido.** `requireAccessToken` lo refresca (mismo camino que `isJwtExpiringSoon`). Así, tras activar el hook, ninguna sesión se queda sin negocio.
  2. **El guard pone en `event.context` `tenantId`** (desde el claim) y el rol (`user_role()`). `UnitOfWork` usa ese `tenantId` en `set_config`.
  3. **El administrador de usuarios lee y escribe `memberships`** del negocio actual en lugar de `profiles.role` (líneas 20, 58 y 78). Crear usuario = crear en Auth + `profiles` (solo nombre) + `memberships`.
  4. **Quitar el *fallback* a `profiles.role`** de `getUserRole` (`server/utils/auth.ts:136-152`).
- **Terminado:** con el hook activo en local, la app funciona igual; las sesiones viejas se refrescan solas; crear, listar y cambiar el rol de un usuario opera sobre `memberships`.

---

### F2-T4 · Migración B: `tenant_id` en todas las tablas (ventana)

- **Archivos:** `supabase/migrations/<ts>_tenant_columns.sql` + su archivo en `rollbacks/`.
- **Patrón por tabla:**

```sql
ALTER TABLE x ADD COLUMN tenant_id uuid;
UPDATE x SET tenant_id = '<negocio #1>';
ALTER TABLE x ALTER COLUMN tenant_id SET NOT NULL,
              ALTER COLUMN tenant_id SET DEFAULT public.tenant_for_insert(),
              ADD CONSTRAINT x_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id);
CREATE INDEX x_tenant_idx ON x (tenant_id);
```

  El `DEFAULT tenant_for_insert()` permite que **las funciones PL/pgSQL y las rutas service-role actuales sigan insertando sin cambios**: con JWT toman el claim; sin JWT, el respaldo de negocio único.

#### Clasificación de las tablas existentes

| Tabla | Acción | Notas |
|---|---|---|
| `products`, `product_categories`, `product_unit_conversions`, `product_prices`, `product_presentation_prices`, `product_wholesale_tiers`, `product_promotions`, `product_customer_group_prices`, `product_search_index`, `product_search_synonyms` | `tenant_id` | — |
| `inventory_balances`, `stock_movements`, `stock_cost_layers`, `inventory_count_sessions`, `inventory_count_items` | `tenant_id` | `location_id` en F5 |
| `purchases`, `purchase_items`, `suppliers`, `supplier_quotes`, `supplier_quote_items` | `tenant_id` | — |
| `sales`, `sale_items`, `sale_cost_allocations`, `sales_orders`, `sales_order_items`, `customers` | `tenant_id` | — |
| `uom_catalog`, `payment_method_catalog`, `customer_groups` | `tenant_id` + **PK `(tenant_id, code)`** | **Decisión:** por negocio, no globales. Cada giro usa unidades (m, kg, gal…), medios de pago (Yape, Plin…) y grupos propios. Se copian al negocio #1. Las plantillas de giro (§8.5) siembran las de los negocios nuevos |
| `combo_workspaces` | `tenant_id` + **PK `(tenant_id, user_id)`** | — |
| `institutions`, `school_grades`, `school_sections`, `school_lists`, `school_list_items`, `school_list_item_brands` | `tenant_id` | Vertical papelería; el prefijo `pap_` va en F8 |
| `outbox_events` (creada en F1) | `tenant_id` | — |
| `profiles` | **Global** | Datos de la persona. Se borra `role` en F2-T10 |
| `stg_productos_import`, `stg_compras_ayrampo_import`, `stg_compras_tania_import`, `import_batches` | **DROP** | Restos de importación, sin RLS (auditoría S6) |
| `whatsapp_sessions` (+ `update_whatsapp_last_interaction`) | **DROP** | D17 |
| `image_cache`, `match_cache` (+ `match_products`, `products.embedding` e índice `products_embedding_idx`) | **DROP si F0/F1 ya retiraron `aiLogic`; si no, `tenant_id` y PK `(tenant_id, hash)`** | `match_cache` guarda IDs de producto: compartido entre negocios filtraría el catálogo de otro. **Ver informe** |

#### Restricciones únicas que pasan a incluir `tenant_id` (baseline)

| Antes | Después |
|---|---|
| `products_sku_key (sku)` | `UNIQUE (tenant_id, sku)` |
| `product_categories_code_key (code)` | `UNIQUE (tenant_id, code)` |
| `sales_orders_order_code_key (order_code)` + `idx_sales_orders_order_code` | `UNIQUE (tenant_id, order_code)`; borrar el índice redundante |
| `inventory_count_sessions_code_key (code)` | `UNIQUE (tenant_id, code)` |
| `school_lists_…_year_key (institution_id, grade_id, section_id, year)` | Se mantiene: los padres ya son de un único negocio |
| `product_search_synonyms (product_id, phrase_norm)`, `uq_product_unit_conversions_product_unit`, `inventory_count_items (session_id, product_id)`, `stock_cost_layers_purchase_item_id_key` | Se mantienen: la clave ya está dentro de un negocio |

#### FK compuestas (defensa contra referencias cruzadas)

**Decisión:** toda FK entre tablas de negocio pasa a ser **compuesta `(tenant_id, x)`**. Así la BD rechaza, por ejemplo, una venta del negocio A con un producto del negocio B, aunque una función `SECURITY DEFINER` o un bug lo intente.

Cada tabla padre recibe `UNIQUE (tenant_id, id)`, o usa su nueva PK compuesta en los catálogos por código. Se reemplazan las 48 FK internas del baseline, entre ellas:
- `sales(customer_id)`, `sale_items(sale_id | product_id)`;
- `products(category_id)`;
- `customers(customer_group)` → `customer_groups (tenant_id, code)`;
- `product_presentation_prices(unit_name)` y `product_promotions(unit_name)` → `uom_catalog (tenant_id, code)`;
- `stock_cost_layers(purchase_id | purchase_item_id | product_id)`;
- `sale_cost_allocations(*)`, `sales_orders(paid_sale_id)`;
- las cadenas de `school_*`.

**Siguen simples** las FK a `auth.users` (`created_by`, `sold_by`, `approved_by`, `applied_by`, `closed_by`, `combo_workspaces.user_id`) y `supplier_quotes.created_by → profiles`: los usuarios son globales.

#### Funciones de búsqueda (se quedan en SQL a largo plazo)

- `search_products_hybrid` y `product_search_pending` reciben `p_tenant_id uuid DEFAULT NULL` y filtran por `coalesce(p_tenant_id, current_tenant(), <respaldo>)`.
- `refresh_product_search_index` y los triggers `trg_*_search_index` propagan `tenant_id` de la fila origen.
- El agente (service-role) pasa `p_tenant_id` explícito en `supabaseAgentCatalog.ts`.

**Terminado:**
- `SELECT table_name FROM information_schema.tables t WHERE table_schema='public' AND table_type='BASE TABLE' AND NOT EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_name=t.table_name AND c.column_name='tenant_id')` devuelve solo las tablas de plataforma y `profiles`.
- `count(*) WHERE tenant_id IS NULL` = 0 en todas las tablas.
- El seed de F2-T1 (SKU y códigos repetidos entre A y B) carga sin conflictos.

---

### F2-T5 · Migración C: RLS por negocio (ventana)

- **Archivos:** `supabase/migrations/<ts>_tenant_rls.sql` + su archivo en `rollbacks/`.

**Patrón.** Una política **RESTRICTIVE** por tabla, que se combina con AND con cualquier otra política:

```sql
CREATE POLICY tenant_guard ON x AS RESTRICTIVE FOR ALL TO authenticated, app_backend
  USING (tenant_id = public.current_tenant())
  WITH CHECK (tenant_id = public.current_tenant());
```

**Políticas permisivas existentes.** Se conservan, pero «autenticado» pasa a significar «miembro del negocio»:
- `*_all_auth` (`auth.uid() IS NOT NULL`) → `has_tenant_role('{owner,manager,cashier}')`.
- `*_owner` / `*_insert_owner` / `*_update_owner` / `*_delete_owner` siguen con `is_owner()`, ya reescrita por negocio.
- `combo_workspaces_*_own` conservan `auth.uid() = user_id`.
- El endurecimiento a «escritura solo por casos de uso» (auditoría S5) no es de esta fase: llega cuando cada tabla deja de escribirse por PostgREST (F3–F6).

**Tablas de plataforma:**

| Tabla | Lectura | Escritura |
|---|---|---|
| `tenants` | Si existe una membresía del usuario | Solo backend / `platform_admins` |
| `memberships` | Las del negocio actual (`is_owner()`) o las propias | Solo backend con `users.manage` |
| `tenant_settings`, `tenant_modules`, `locations` | Miembros del negocio | `is_owner()` |
| `platform_admins`, `platform_config` | Sin acceso para `authenticated` | Sin acceso para `authenticated` |

**`profiles` (global).**
- SELECT: el propio perfil, o los de usuarios con membresía en el negocio actual. Hoy cualquier autenticado ve **todos** los perfiles (`baseline.sql:4011`), y entre negocios eso sería una fuga.
- UPDATE: el propio, solo `full_name`.

**Vistas.** `product_catalog` ya es `security_invoker` (`baseline.sql:2326`), así que hereda RLS. Toda vista nueva debe serlo.

**Permisos:**
- `REVOKE ALL ON ALL TABLES, SEQUENCES, FUNCTIONS IN SCHEMA public FROM anon`.
- `ALTER DEFAULT PRIVILEGES … REVOKE … FROM anon`.
- `authenticated` **conserva** sus permisos hasta el cierre de F7 (§1.1).

**Terminado:**
- `pg_policies` muestra `tenant_guard` en todas las tablas con `tenant_id`.
- Ninguna política usa `auth.uid() IS NOT NULL` como única condición.
- El test de aislamiento (F2-T8) pasa.

---

### F2-T6 · Activar el hook de token en producción (ventana)

- **Pasos:**
  1. Activar el *Custom Access Token Hook* en el panel de Supabase, con la función `public.custom_access_token_hook`.
  2. Las sesiones existentes se refrescan solas al primer uso (F2-T3, paso 1).
  3. El agente: las sesiones de vendedor (`supabaseSellerAuth`) obtienen el claim en su próximo refresh. Hay que verificar con una vinculación nueva por `/vincular`.
- **Terminado:** un JWT recién emitido trae `tenant_id` y `tenant_role`. El POS vende y el agente registra en dry-run.

---

### F2-T7 · Esquema de Drizzle (ventana o inmediatamente después)

- **Archivos:** el esquema de Drizzle de F1 (`layers/core/server/shared/infrastructure/db/schema.ts`).
- **Pasos:** `drizzle-kit pull` contra local con las migraciones de F2 aplicadas (D37). Revisar el diff y no editarlo a mano.
- **Terminado:** typecheck en verde; `UnitOfWork` hace una lectura con `set_config` y solo ve el negocio fijado.

---

### F2-T8 · Test de aislamiento en CI

- **Archivos:** `tests/isolation/*.test.ts` (Vitest) y `.github/workflows/ci.yml`.
- **Diseño:** sobre el seed de dos negocios, por cada tabla con `tenant_id`, por los dos caminos (JWT por PostgREST y `app_backend` con `set_config`), comprobar:
  1. Un usuario de A no **lee** filas de B (SELECT → 0 filas).
  2. Un usuario de A no **inserta** con `tenant_id` de B (error RLS) ni **actualiza o borra** filas de B (0 filas afectadas).
  3. Una FK cruzada (`sale_items` de A con un `product_id` de B) falla por la FK compuesta, **incluso ejecutada como `postgres`**.
  4. El usuario con dos membresías solo ve el negocio de su claim o de su `set_config`.
  5. Sin negocio (`app_backend` sin `set_config`, JWT sin claim) se ven **0 filas**.
  6. `anon` no lee ninguna tabla de `public`.
  7. Toda tabla nueva sin `tenant_guard` hace fallar el test. Se detecta consultando el catálogo, así cubre las tablas futuras.
- **Terminado:** el job corre en CI y es requisito del merge.

---

### F2-T9 · Registro de la puerta del segundo negocio

- **Pasos:** dejar en «Registro de cambios» la lista exacta de rutas service-role y funciones `SECURITY DEFINER` pendientes (§1.1), con el archivo y la fase que las elimina. Cada fase posterior las tacha.
- **Terminado:** la lista existe y coincide con `grep getSupabaseAdminClient` y `pg_proc.prosecdef`.

---

### F2-T10 · Limpieza

- **Pasos:**
  - `ALTER TABLE profiles DROP COLUMN role` (verificar antes que `grep -rn "role" … profiles` no encuentre lecturas).
  - `handle_new_user` pasa a crear solo el perfil (sin rol). En un sistema con registro cerrado, la membresía la crea quien invita.
  - Borrar `idx_sales_orders_order_code`.
  - Borrar tablas y funciones marcadas DROP que hayan quedado vivas para el rollback de la ventana.
- **Terminado:** la migración aplica limpio en CI y staging; la app funciona igual.

## 5. Cómo verificar

| Qué | Cómo |
|---|---|
| Migraciones desde cero + lint SQL | `pnpm db:reset`; `supabase db lint --local --level error` (ya en CI) |
| Aislamiento | `pnpm test:isolation` (F2-T8) y CI |
| Columnas | Consulta de F2-T4 (solo plataforma y `profiles` sin `tenant_id`); `tenant_id IS NULL` = 0 |
| Políticas | `SELECT tablename, policyname, permissive FROM pg_policies WHERE schemaname='public' ORDER BY 1` |
| Claim | Decodificar un access token nuevo: trae `tenant_id` |
| Regresión funcional | Playwright: login, venta, compra, conteo y cierre (F1), en staging y después en producción |
| Conteo de datos | Antes y después de la ventana, `count(*)` por tabla. Deben coincidir (salvo las tablas borradas) |

## 6. Cómo volver atrás

- **F2-T1 a F2-T3 (aditivas):** se revierten con su archivo de `supabase/rollbacks/`, o simplemente no se continúa. El hook no está activo en producción.
- **Dentro de la ventana:** no hay escrituras de usuarios (POS cerrado). Si algo falla:
  1. desactivar el hook en el panel;
  2. restaurar el respaldo tomado al inicio de la ventana (`pnpm db:backup` / `db:release` paso 4; `schema.sql` + `data.sql` + `roles.sql` en `$PAPELERIA_BACKUP_DIR/prod-<fecha>`);
  3. volver a desplegar en Vercel el commit anterior.

  El procedimiento de restauración **se ensaya en staging** antes de la ventana.
- **Después de la ventana:** errores puntuales se corrigen hacia adelante con una migración nueva. La restauración completa ya implicaría perder ventas, así que solo se usa como último recurso.

### Guion de la ventana de mantenimiento (D21)

1. **T-7 días.** Ensayo completo en staging: migraciones B y C, hook, Playwright, restauración del respaldo. Anotar la duración real.
2. **T-1 día.** Avisar a la papelería. Verificar que F2-T2 y F2-T3 están en producción y estables.
3. **T0.** Cerrar el POS (cajas cerradas, sin pedidos en curso). Poner la app en modo mantenimiento: página estática o variable que el guard respeta.
4. `pnpm db:backup`. Guardar la ruta del respaldo y los conteos por tabla.
5. `pnpm db:release` con las migraciones B y C (incluye su propio respaldo y pruebas locales).
6. Activar el hook (F2-T6).
7. Verificaciones de §5 en producción: conteos, columnas, políticas y claim.
8. Prueba con un usuario real: login, venta de prueba anulada, compra de prueba borrada, consulta de reportes.
9. Quitar el modo mantenimiento.
10. **Criterio de abortar:** si cualquier paso del 5 al 8 falla y no se resuelve en 30 minutos, se aplica §6.

## 7. Riesgos

| Riesgo | Mitigación |
|---|---|
| Fuga entre negocios por rutas service-role o funciones `SECURITY DEFINER` | Solo un negocio hasta la puerta §1.2; FK compuestas; lista F2-T9 |
| Sesiones sin claim tras la ventana | F2-T3: token sin claim = vencido → refresh |
| Una función PL/pgSQL inserta sin negocio | `DEFAULT tenant_for_insert()` con respaldo de negocio único; test de inserción de cada RPC en staging |
| Migración B lenta (backfill + FK compuestas sobre tablas grandes) | Medir en el ensayo; crear las FK con `NOT VALID` + `VALIDATE CONSTRAINT` |
| La búsqueda vectorial (HNSW) con filtro por negocio devuelve menos resultados | Medir en el ensayo; subir `hnsw.ef_search` o activar el escaneo iterativo de pgvector si hace falta |
| La política `tenant_guard` olvidada en una tabla futura | Test F2-T8.7 sobre el catálogo |
| Restaurar el respaldo nunca se probó | Ensayo obligatorio en staging (paso 1 del guion) |
| El hook de Auth falla y nadie puede iniciar sesión | Probarlo en staging; desactivarlo es inmediato desde el panel |

## 8. Registro de cambios

| Fecha | Cambio |
|---|---|
| 2026-11-18 | Consolidación: el negocio #1 usa el id de D47 (`DEFAULT_TENANT_ID` de la Fase 1) y `fallback_tenant_id` apunta a él; la Fase 2 **reemplaza** la política temporal `app_backend_all` creada en la Fase 1; se agrega la tabla `membership_permissions(tenant_id, user_id, permission)` (D57); la transición de acceso a datos queda registrada como D46. `image_cache`/`match_cache` se conservan hasta la Fase 8 (D49): `match_cache` recibe `tenant_id` porque guarda IDs de producto. |
| 2026-11-18 | Documento inicial (antes de la validación de inicio de fase) |
