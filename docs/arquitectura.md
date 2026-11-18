# Arquitectura objetivo — Plataforma de ventas, compras e inventario

> Versión 1.4 · 2026-11-18. Diseño objetivo y contratos de desarrollo. La [auditoría](auditoria-2026-11-18.md) describe el punto de partida y el [índice de fases](fases/README.md) indica la primera entrega.
> Documento vivo: toda decisión nueva se agrega en la sección 2 (registro de decisiones).

---

## 1. Contexto y objetivo

**Hoy.** La app es un sistema para una papelería: Nuxt 3 (SPA) + Supabase + Vercel. Las reglas de negocio están repartidas entre funciones PL/pgSQL (`create_sale`, FIFO, precios) y código TypeScript sin transacciones. No existe el concepto de "negocio". Tiene fallas de seguridad críticas.

**Objetivo.** Una **plataforma SaaS multi-negocio** de ventas, compras y control de inventario para negocios pequeños:
- un **núcleo genérico** (lo que todo negocio usa);
- **módulos transversales** (opcionales para cualquier giro);
- **módulos verticales** por giro: papelería, ferretería, taller automotriz…

La papelería actual pasa a ser el **primer negocio** y su lógica propia el **primer módulo vertical**.

**Equipo.** Los desarrolladores del proyecto, apoyados por agentes de IA (Claude Code, Codex). No hay fecha objetivo. Esto condiciona el diseño (sección 15): las convenciones explícitas, las validaciones automáticas y las fases pequeñas y verificables valen más que cualquier patrón sofisticado.

---

## 2. Registro de decisiones

| # | Decisión | Estado |
|---|---|---|
| D1 | Monolito modular, **un solo despliegue**. Sin microservicios | Aprobada |
| D2 | **Hexagonal** (puertos y adaptadores) en los contextos con reglas de negocio; **CRUD en capas** (`handler → repo`) donde no hay reglas | Aprobada |
| D3 | Las reglas de negocio **salen de PostgreSQL** y pasan a TypeScript (dominio). La BD conserva la integridad (FK, CHECK, UNIQUE), RLS, índices, búsqueda y consultas de lectura | Aprobada |
| D4 | **Multi-inquilino** con BD compartida + `tenant_id` + RLS | Aprobada |
| D5 | **Núcleo + módulos transversales + módulos verticales**, implementados como **Nuxt Layers** y activados por negocio en tiempo de ejecución | Aprobada |
| D6 | Stack: **Nuxt (4, ver D34) + Supabase (Postgres y Auth) + Vercel**. Se agregan **Drizzle** (conexión directa con transacciones) y **Pinia** (estado global del cliente) | Aprobada |
| D7 | **Ubicaciones** (sucursal/almacén) en el núcleo desde el inicio; cada negocio arranca con una | Aprobada |
| D8 | **Sesión de caja** (apertura, cierre, arqueo) en el núcleo | Aprobada |
| D9 | **Impuestos:** precio con impuesto incluido, configurable por negocio; tasa por producto (gravado/exonerado) | Aprobada |
| D10 | **Documento de venta** con serie, correlativo y tipo desde el inicio. El envío a SUNAT es un módulo transversal posterior | Aprobada |
| D11 | **Crédito (fiado)** como módulo transversal | Aprobada |
| D12 | **Devoluciones y anulaciones** en el núcleo, como documento que revierte la venta original | Aprobada |
| D13 | Solo **Perú** al inicio; moneda e impuestos configurables por negocio | Aprobada |
| D14 | Alta de negocios **manual (por el administrador de la plataforma)**; autoregistro después | Aprobada |
| D15 | Suscripción y cobro **fuera de alcance**; solo `tenants.plan` | Aprobada |
| D16 | POS **solo en línea** (sin modo offline) | Aprobada |
| D17 | **WhatsApp se elimina** y se rehace después como canal del agente | Aprobada |
| D18 | El estado del agente IA pasa de archivos a la **BD** | Aprobada |
| D19 | El modo `llm` del agente pasa a ser el default y **se elimina `legacy`** (tras la última validación del benchmark) | Aprobada |
| D20 | **Stock con una sola fuente:** movimientos + lotes FIFO por ubicación; `inventory_balances` como saldo derivado; se elimina `products.stock_on_hand` | Aprobada |
| D21 | La migración a multi-negocio se hace en una **ventana de mantenimiento corta y planificada** | Aprobada |
| D22 | **Sentry** para errores (cliente y servidor), con negocio y usuario en cada evento | Aprobada |
| D23 | **Tareas en segundo plano:** despacho del outbox justo después del commit + barrido cada minuto con **`pg_cron`**. Evaluar **Inngest** al llegar la facturación electrónica | Aprobada |
| D24 | **Vitest** (unitarios, integración, caracterización, aislamiento) + **Playwright** (flujos completos). Reemplaza `node --test` | Aprobada |
| D25 | **ESLint (`@nuxt/eslint`) + `vue-tsc` + `dependency-cruiser`** obligatorios en CI | Aprobada |
| D26 | **Rate limiting** (Upstash Redis) en login, `/vincular`, agente y consumo de IA por negocio. Requisito antes del segundo negocio | Aprobada |
| D27 | **Correo transaccional** (Resend) como SMTP de Supabase Auth y para invitaciones. Requisito antes del segundo negocio | Aprobada |
| D28 | **PITR** (recuperación a un punto en el tiempo) en Supabase. Requisito antes del segundo negocio | Aprobada |
| D29 | **Nuxt UI** (incluye Iconify) como librería de componentes; **VueUse** como utilidades | Aprobada |
| D30 | **Gráficos con librería** (ECharts vía `vue-echarts`, o Unovis) al rehacer los reportes; se elimina el SVG a mano | Aprobada |
| D31 | **Esquemas zod compartidos** entre cliente y servidor | Aprobada |
| D32 | **Renovate** para actualizar dependencias | Aprobada |
| D33 | **No se usan:** Vuex, TanStack Query, GraphQL, Redis como caché, Docker/Kubernetes en producción, servicio externo de feature flags | Aprobada |
| D34 | Nuxt 4, Tailwind 4 y Node 26 LTS como objetivo. F1 caracteriza la versión actual y verifica dependencias, build, CI y preview antes de fijar `26.x` en todos los entornos. | A validar en F1 |
| D35 | **Código en inglés** (funciones, clases, tablas, columnas); interfaz y documentos en español. Glosario en la sección 18 | Aprobada |
| D36 | El código nuevo se escribe **desde el primer día en su ubicación final** (`layers/…`); no se mueve después | Aprobada |
| D37 | **Esquema:** las migraciones solo con Supabase CLI; el esquema de Drizzle se genera desde la BD (`drizzle-kit pull`). **Nunca** migraciones de Drizzle | Aprobada |
| D38 | **Dinero y cantidades:** tipo `Money`/`Quantity` sobre una librería decimal (big.js). Nunca `number` de JS para montos. En la BD, `numeric`. **IGV redondeado por línea** (como SUNAT) | Aprobada |
| D39 | **Stock negativo bloqueado** siempre (igual que hoy `create_sale`) | Aprobada |
| D40 | **Devolución:** el producto vuelve con el **costo FIFO original** de la venta (`sale_cost_allocations`) | Aprobada |
| D41 | **Ajuste positivo de conteo:** crea un lote FIFO con el **último costo de compra** del producto; si nunca se compró, el costo promedio | Aprobada |
| D42 | **Correlativos:** tabla `document_series(tenant_id, doc_type, series, next_number)`; el número se toma con bloqueo de fila **dentro de la transacción** de la venta. Sin huecos, seguro ante ventas simultáneas | Aprobada |
| D43 | **Staging:** segundo proyecto Supabase + entorno de Vercel, con **datos sintéticos** (`supabase/seed.sql`). Los datos de producción no se copian a staging | Aprobada |
| D44 | Respaldo antes de cada migración de producción. Verificar que el plan de Vercel cubre la operación comercial desde la primera tienda. Supabase Pro, PITR y restauración ensayada antes del segundo negocio. | Aprobada |
| D45 | **Matriz de permisos** de la sección 10.1 | Aprobada |
| D46 | **Transición de acceso a datos (Fases 2 a 7):** conviven dos caminos. (a) PostgREST con el JWT del usuario, que lleva el claim `tenant_id` puesto por un **Custom Access Token Hook** de Supabase Auth; (b) Drizzle con `app_backend` y `set_config`. `current_tenant()` lee ambos. El interruptor `db` de los casos de uso sigue usando el cliente de usuario (así las RPC antiguas siguen viendo `auth.uid()`). En la Fase 2 se revoca **solo `anon`**; `authenticated` se revoca al cerrar la Fase 7 | Aprobada |
| D47 | **Negocio por defecto:** id fijo `00000000-0000-0000-0000-000000000001` desde la Fase 1 (`DEFAULT_TENANT_ID`). La Fase 2 crea la papelería con ese id y usa `tenant_for_insert()` con respaldo de negocio único hasta la puerta del 2.º negocio | Aprobada |
| D48 | **Layers con `extends` explícito** en el `nuxt.config.ts` raíz. Nuxt 4 solo autodetecta subcarpetas directas de `layers/`, y se mantiene la agrupación `modules/` y `verticals/`. Se elimina `nitro.ignore: ['**/modules/**']` | Aprobada |
| D49 | La **lectura de listas por foto** (`utiles`: `analyzeImageCore`, `matchProductsCore`, `match_products`, `image_cache`, `match_cache`, `scripts/embed-catalog.mjs`) **se conserva** hasta la Fase 8, donde pasa al vertical papelería. D17 solo elimina WhatsApp | Aprobada |
| D50 | **Kits:** la composición y el consumo de stock de un kit (`item_kind = kit`) son del **núcleo**; el módulo `kits` es el planificador de combos actual | Aprobada |
| D51 | **Precio base:** fuente única `product_prices` (contexto `pricing`); `products.sale_price` queda como copia derivada hasta la Fase 7. Se agregan `products.tax_category` y `tenant_settings.default_customer_group` | Aprobada |
| D52 | **`min_stock` por ubicación**, en el contexto `inventory` (Fase 5) | Aprobada |
| D53 | **Reportes:** rango de fechas libre + `tenant_settings.reporting_start_date`. Desaparecen los periodos fijos de la papelería (`recovery_2025_to_2026_03_08`, …) | Aprobada |
| D54 | **Agente:** credenciales por negocio en la tabla `agent_credentials`; la moneda viene de `tenant_settings` (hoy `'PEN'` fijo en `api/agent/context.get.ts`) | Aprobada |
| D55 | Se agrega el permiso **`sales.approve`** (dueño, encargado), que hoy ya aplica `create_sale` para `approved_by` | Aprobada |
| D56 | El total nuevo suma los importes redondeados por línea. La diferencia frente al método histórico puede acumularse. Cada ejemplo de caracterización comprueba los dos importes exactos. | Aprobada |
| D57 | **Permisos concedidos por usuario:** además de los permisos de su rol, el dueño puede conceder permisos puntuales a un usuario (p. ej. `sales.manual_discount` a un cajero de confianza). Tabla `membership_permissions` en la Fase 2; se evalúa en `defineApiHandler` y en el dominio | Aprobada |
| D58 | **Corrección de compras:** solo de líneas cuyo lote FIFO no fue consumido; para lo demás, un ajuste o una devolución al proveedor | Aprobada |
| D59 | **Conteo de inventario:** se aplica la **diferencia** detectada al contar (contado − sistema al contar) sobre el stock del momento, no el valor absoluto | Aprobada |
| D60 | **Anulación** solo mientras la caja de la venta siga abierta; después, devolución | Aprobada |
| D61 | Las ventas en efectivo **del agente** exigen caja abierta del vendedor | Aprobada |
| D62 | Un **método de pago desconocido** se rechaza con error (hoy se convierte en `efectivo` sin avisar) | Aprobada |
| D63 | **Cotizaciones a clientes:** fuera de esta refactorización; serán el primer módulo transversal nuevo después de la Fase 9 | Aprobada |
| D64 | Supabase autentica a la persona. Nitro verifica la sesión por petición y resuelve membresía, permisos y módulos del negocio activo según §7.2. El cierre habitual afecta al terminal actual. | Adoptada para el desarrollo |
| D65 | Cada contexto tiene un responsable de escritura (§5.1). El caso de uso que inicia la operación comparte la misma transacción con los contextos participantes. | Adoptada para el desarrollo |
| D66 | Un pedido conserva el precio pactado. Cobrarlo toma la instantánea guardada por el servidor. La clave de idempotencia identifica el cobro lógico a través de sus reintentos y canales. | Adoptada para el desarrollo |
| D67 | La aplicación raíz compone los módulos. El núcleo define sus contratos. Los adaptadores compartidos de búsqueda e IA se inyectan en los módulos que los necesitan. | Adoptada para el desarrollo |

### 2.1 Stack tecnológico

**Frontend**

| Capa | Herramienta | Uso | Estado |
|---|---|---|---|
| Framework | Nuxt 4 (Vue 3), modo SPA | Aplicación | Existe (hoy Nuxt 3.21; migra en Fase 1) |
| Módulos | Nuxt Layers | Una capa por núcleo, módulo transversal y vertical | Nuevo |
| Estado global | Pinia | Sesión, negocio activo, módulos, carrito, caja | Nuevo |
| Datos del servidor | Composables sobre `useFetch`/`$fetch` | Lecturas y escrituras por funcionalidad. **No** se copian a Pinia | Convención |
| Estilos | Tailwind CSS | — | Existe |
| Componentes | Nuxt UI + Iconify | Tablas, formularios, modales, menús, notificaciones, iconos | Nuevo |
| Utilidades | VueUse | Debounce, almacenamiento persistido, atajos, lector de código de barras | Nuevo |
| Validación | zod (compartido) | Formularios y API con el mismo esquema | Convención |
| Gráficos | ECharts (`vue-echarts`) o Unovis | Reportes | Fase 7 |
| Excel | xlsx (carga diferida) | Importación | Existe, con ajuste |
| Errores | Sentry | — | Nuevo |

**Backend y datos**

| Capa | Herramienta | Uso | Estado |
|---|---|---|---|
| Servidor | Nitro (Nuxt) en Vercel | Rutas HTTP, casos de uso | Existe |
| Base de datos | Supabase Postgres (pgvector, pg_trgm, unaccent, pgcrypto) | Datos, RLS, búsqueda, lectura | Existe |
| Acceso a datos | Drizzle + `postgres.js` vía Supavisor (modo transacción) | Transacciones del dominio | Nuevo |
| Autenticación | Supabase Auth + cookies httpOnly | Login y sesiones | Existe |
| Tareas | `pg_cron` (Inngest se evalúa según D23) | Outbox, vencimientos, reintentos | Nuevo |
| IA | OpenAI (SDK `openai`) | Agente, embeddings | Existe |
| Validación | zod | Entrada de API, salidas estructuradas de IA | Existe, se extiende |
| Rate limiting | Upstash Redis | Protección y control de gasto | Antes del 2.º negocio |
| Correo | Resend | Invitaciones, recuperación de contraseña | Antes del 2.º negocio |
| Integración IA | Yachay Connector (Python, MCP) | Canal de Claude | Existe |

**Calidad y operación**

| Herramienta | Uso | Estado |
|---|---|---|
| GitHub Actions | CI: migraciones limpias, lint SQL, build, tests | Existe, se extiende |
| Vitest + `@nuxt/test-utils` | Tests unitarios, de integración, caracterización y aislamiento | Nuevo |
| Playwright | Login, venta, compra, cierre de caja | Nuevo |
| ESLint + vue-tsc + dependency-cruiser | Calidad y reglas de capas | Nuevo |
| Supabase CLI | Migraciones y entornos (local, staging, producción) | Existe |
| Supabase PITR | Respaldos | Antes del 2.º negocio |
| Sentry | Errores y alertas | Nuevo |
| Renovate | Dependencias | Nuevo |

---

## 3. Estilo arquitectónico

**Monolito modular multi-inquilino, con núcleo hexagonal y módulos extensibles por giro.**

```text
┌──────────────────── MÓDULOS VERTICALES (por giro) ───────────────────┐
│ Papelería            Ferretería             Taller automotriz          │
│ · listas escolares   · venta por medida     · vehículos                │
│ · kits escolares     · cotización por obra  · órdenes de trabajo       │
│ · lectura de lista   · equivalencias        · citas · garantías        │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ API pública del núcleo + eventos
┌─────────────────── MÓDULOS TRANSVERSALES (cualquier giro) ───────────┐
│ Cotizaciones a clientes · Crédito · Kits/combos · Agente IA            │
│ Facturación electrónica PE · (WhatsApp, a futuro)                      │
└───────────────────────────────┬─────────────────────────────────────┘
┌──────────────────────── NÚCLEO (siempre activo) ─────────────────────┐
│ Identidad y negocios · Catálogo · Precios · Inventario · Compras       │
│ Ventas y caja · Clientes · Proveedores · Reportes                      │
└──────────────────────────────────────────────────────────────────────┘
```

**Regla de ubicación:** si lo necesitan **dos o más giros**, va al núcleo o a un módulo transversal. Si es de un solo giro, va a su vertical.

---

## 4. Reglas de dependencia

1. **Vertical o transversal → núcleo:** solo a través de la **API pública del núcleo**, es decir, los casos de uso exportados en `contexts/<x>/index.ts`. Nunca tablas, repositorios ni archivos internos.
2. **Núcleo → módulo:** **prohibido**. El núcleo no conoce vehículos, listas escolares ni obras.
3. **Módulo → módulo:** prohibido directo; solo vía eventos. La excepción es una dependencia declarada en el manifiesto (p. ej. `taller` depende de `quotes`).
4. **Dentro de un contexto hexagonal:**
   - `domain` no importa nada externo (ni Nuxt, ni Drizzle, ni OpenAI);
   - `application` solo conoce `domain` y sus `ports`;
   - `infrastructure` implementa los ports.
5. Las reglas **se validan en CI** con `dependency-cruiser`. Una violación rompe el build.

---

## 5. El núcleo

### 5.1 Contextos y su forma

| Contexto | Forma | Casos de uso principales |
|---|---|---|
| **identity** (negocios, usuarios, roles) | Hexagonal | CrearNegocio, InvitarUsuario, CambiarRol, ActivarModulo |
| **catalog** (productos, unidades, conversiones, categorías) | Hexagonal | GuardarProducto, ReemplazarConversiones, ConvertirUnidad |
| **pricing** | Hexagonal (cálculo puro) | ResolverPrecio (mayoreo, promoción, grupo de cliente, presentación, descuento manual por rol, impuestos) |
| **inventory** | Hexagonal | RegistrarMovimiento, ConsumirFIFO, ReservarStock, LiberarReserva, Transferir, IniciarConteo, AplicarConteo, CerrarConteo |
| **purchasing** | Hexagonal | RegistrarCompra, CorregirCompra, cotizaciones de proveedor |
| **sales** | Hexagonal | RegistrarVenta, CrearPedido, CobrarPedido, AnularVenta, RegistrarDevolucion, AbrirCaja, CerrarCaja |
| **customers**, **suppliers** | CRUD | — |
| **settings** (configuración por negocio) | CRUD | Moneda, zona horaria y preferencias. Las pantallas de configuración llaman al contexto responsable de cada maestro. |
| **reports** | Solo lectura (SQL) | Ver sección 9 |

**Responsables de escritura.** Catálogo mantiene productos, categorías, unidades, conversiones y composición de kits (`stock_item`, `service`, `kit`). Precios mantiene tarifas y reglas. Inventario registra movimientos, lotes, reservas y saldos por ubicación. Compras conserva la compra y sus correcciones. Ventas conserva los precios pactados, pagos, devoluciones y movimientos de caja. Reportes lee los registros emitidos. Una compra o venta abre una transacción y pasa sus repositorios transaccionales a inventario y caja. Un fallo en cualquiera de los pasos revierte la operación completa.

### 5.2 Generalizaciones del modelo (huecos detectados en el código actual)

| Hoy | Objetivo |
|---|---|
| Todo producto es un bien. `product_type` guarda en realidad el nombre de la categoría (`baseline.sql:1115`) | `item_kind`: **bien inventariable · servicio (sin stock) · kit** |
| Sin atributos extensibles | `products.attributes` JSONB, validado por el esquema de cada módulo activo |
| Stock en dos lugares (`inventory_balances` y `products.stock_on_hand`), sin ubicación | Stock por **ubicación** = movimientos + lotes FIFO; saldo derivado |
| Reservas solo en memoria del agente (`agent/app/reservations.ts`) | **Reservas persistentes** en el núcleo (pedidos, cotizaciones, órdenes de trabajo) |
| La venta es un ticket de POS | **Documento de venta** (tipo, serie, correlativo) con líneas de bienes y servicios; puede originarse en POS, pedido, cotización u orden de trabajo |
| Sin caja, sin devoluciones | Sesión de caja; devolución y anulación como documentos que revierten |
| `PEN` y hora de Lima fijos en el código | `tenant_settings`: moneda, zona horaria, impuesto por defecto, decimales |
| Roles globales en `profiles.role` | `memberships(user_id, tenant_id, role)`: rol por negocio |

---

## 6. Hexagonal: cómo se implementa

### 6.1 Capas de un contexto

```text
contexts/sales/
  domain/          Sale.ts, SaleLine.ts, rules.ts                  ← puro, con tests unitarios
  application/     registerSale.ts, voidSale.ts, ports.ts          ← orquesta, usa ports
  infrastructure/  drizzleSalesRepository.ts                       ← implementa ports
  index.ts         API pública del contexto (lo único importable desde fuera)
```

Los nombres del código van en inglés (D35). En este documento los casos de uso aparecen con su nombre de negocio en español; la equivalencia está en el glosario (sección 18).

### 6.2 Puertos estándar

- **Repositorios** por agregado (`SalesRepository`, `StockRepository`…).
- **`UnitOfWork`**: ejecuta un caso de uso en **una transacción**; todo se confirma o nada.
- **`TenantContext`**: negocio, usuario y rol actuales.
- **`Clock`**: la hora, inyectada para poder probarla.
- **`EventPublisher`**: escribe en el outbox (sección 8.3).
- **Integraciones**: `ProveedorIA`, `BuscadorProductos`, `Facturador`, `Notificador`.

### 6.3 Lo que la BD hacía gratis y cómo se conserva

| Garantía | Cómo se conserva |
|---|---|
| **Atomicidad** (venta + stock + FIFO juntos) | `supabase-js` (PostgREST) **no tiene transacciones**. El backend usa **conexión directa** a Postgres con Drizzle + `postgres.js` vía el pooler de Supabase (Supavisor, modo transacción, `prepare: false`). Cada caso de uso corre dentro de `UnitOfWork` |
| **Concurrencia** (dos cajeros, último producto) | `SELECT … FOR UPDATE` sobre saldo y lotes FIFO dentro de la transacción. Test de concurrencia obligatorio en inventory |
| **Aislamiento entre negocios** | Cada transacción ejecuta `set_config('app.tenant_id', …, true)` y `set_config('app.user_id', …, true)`. **RLS sigue activo**. El backend se conecta con el rol `app_backend` (**NOBYPASSRLS**), nunca con `postgres` ni service-role |
| **Integridad** | FK, CHECK, UNIQUE y NOT NULL se quedan en la BD |

### 6.4 Uso de Supabase

- **Auth:** login, refresh y gestión de usuarios (sin cambios en el mecanismo de cookies httpOnly).
- **Datos (estado final):** solo vía `app_backend`. Se **revocan** los permisos de `anon` y `authenticated` sobre las tablas de la app, así que PostgREST deja de ser una puerta de entrada a los datos.
- **Datos (transición, Fases 2 a 7):** conviven PostgREST con el JWT del usuario (claim `tenant_id`) y Drizzle con `set_config`, según D46.
- **service-role:** solo para tareas de plataforma (crear usuarios en Auth), aisladas en un adaptador.

---

## 7. Multi-inquilino

### 7.1 Tablas de plataforma

```text
tenants          (id, name, business_type, plan, status, created_at)
platform_admins  (user_id)                            alta explícita y auditada
session_tenants   (session_id, user_id, tenant_id)     selección por terminal
membership_permissions (tenant_id, user_id, permission)
memberships      (tenant_id, user_id, role, active)            role: owner | manager | cashier
tenant_settings  (tenant_id, currency, timezone, default_tax_rate, price_includes_tax, …)
tenant_modules   (tenant_id, module_id, enabled, config jsonb)
locations        (id, tenant_id, name, kind)           kind: store | warehouse
```

- Todas las tablas de negocio llevan **`tenant_id NOT NULL`**. Las claves únicas incluyen `tenant_id` (p. ej. `UNIQUE (tenant_id, sku)`).
- Las políticas filtran por `current_tenant()` y validan la membresía activa. Durante D46 las peticiones PostgREST también deben corresponder a la selección vigente de la sesión.

### 7.2 Resolución del negocio en cada petición

1. El POS envía correo y contraseña al backend. Supabase Auth emite la sesión y Nitro guarda los tokens en cookies `HttpOnly`, con `Secure` en HTTPS. En cada petición protegida, un único verificador autentica el token y conserva la identidad verificada solo en `event.context`.
2. Una persona sin membresías activas puede gestionar su cuenta, pero recibe 403 en operaciones comerciales. Con una sola se selecciona automáticamente. Con varias, elige un negocio. La selección pertenece a la sesión de ese terminal y se guarda en el servidor mediante el `session_id` verificado. El rol de plataforma se asigna explícitamente por separado.
3. Durante D46, el hook emite el negocio seleccionado en el JWT. Al cambiarlo, el backend valida la membresía y renueva el token antes de permitir operaciones. Guard, RLS y Drizzle deben coincidir en negocio y usuario. Un token anterior, una membresía suspendida o un carrito de otro contexto no pueden registrar una venta. El rol y las concesiones se consultan vigentes. Las escrituras del POS incluyen el negocio y la ubicación esperados al crear el borrador. El servidor los compara con el contexto autorizado antes de aplicar el cobro.
4. Cerrar sesión revoca la renovación en el terminal actual y limpia sus cookies y estado de interfaz. Un fallo temporal de Auth se comunica como indisponibilidad. Las invitaciones, recuperación y suspensión se prueban con usuarios nuevos y existentes en F2.

### 7.3 Administración de la plataforma

Hay un rol de plataforma (`platform_admin`) separado de los roles de negocio. Solo ese rol crea negocios (D14). Es el único que puede operar entre negocios, a través de rutas `/api/platform/*` auditadas.

---

## 8. Extensión: cómo un módulo extiende el núcleo sin modificarlo

### 8.1 Cuatro mecanismos (de menor a mayor acoplamiento)

| Mecanismo | Uso | Ejemplo |
|---|---|---|
| **Llamar casos de uso del núcleo** | El módulo genera ventas, compras o reservas | Cerrar una orden de trabajo → `RegistrarVenta` (mano de obra + repuestos) |
| **Eventos de dominio** | Reaccionar a lo que pasa en el núcleo | `VentaRegistrada` → el módulo de crédito crea la cuenta por cobrar |
| **Puntos de extensión** | Insertar una regla dentro de un flujo del núcleo | `ModificadorPrecio` (temporada escolar), `ValidadorVenta` (el taller exige vehículo) |
| **Datos propios** | Información que el núcleo no conoce | `tal_vehiculos`, `pap_listas`: referencian IDs del núcleo, nunca al revés |

### 8.2 Atributos de producto

`products.attributes` (JSONB). Cada módulo declara en su manifiesto un **esquema zod** de los atributos que aporta (ferretería: medida y material; papelería: presentación; taller: compatibilidad). El caso de uso `GuardarProducto` valida contra los esquemas de los módulos activos. Los datos con relaciones van en tablas del módulo.

### 8.3 Eventos con outbox transaccional

- El caso de uso escribe el evento en la tabla `outbox_events` **dentro de la misma transacción**.
- La entrega se identifica por evento y suscriptor. Cada destino conserva sus intentos y resultado. Se reintentan los pendientes con el mismo identificador y se alerta sobre entregas atascadas.
- Al confirmar, un despachador entrega el evento a los suscriptores de los módulos activos del negocio.
- Los manejadores son **idempotentes**, porque un evento puede llegar dos veces.
- Si un manejador debe ser **consistente con la operación** (por ejemplo, un validador), no se usa un evento: se usa un **punto de extensión síncrono** dentro de la transacción.

Eventos iniciales del núcleo: `VentaRegistrada`, `VentaAnulada`, `DevolucionRegistrada`, `CompraRegistrada`, `StockAjustado`, `StockBajo`, `CajaCerrada`.

### 8.4 Manifiesto de módulo

```ts
// layers/verticals/taller/module.ts
export default defineModule({
  id: 'taller',
  name: 'Taller automotriz',
  kind: 'vertical',
  dependsOn: ['quotes'],
  permissions: ['taller.ordenes.ver', 'taller.ordenes.cerrar'],
  menu: [{ label: 'Órdenes de trabajo', to: '/taller/ordenes', permission: 'taller.ordenes.ver' }],
  productAttributes: TallerAttributesSchema,
  extensions: { validadorVenta: exigirVehiculo },
  subscribes: { VentaAnulada: reabrirOrden },
})
```

### 8.5 Nuxt Layers y activación

- Cada módulo es una **Nuxt Layer** con sus propias `pages/`, `components/`, `server/api/` y `module.ts`.
- La aplicación raíz importa los manifiestos en `server/plugins/modules.ts` e inyecta los adaptadores compartidos. El núcleo expone los contratos de registro, búsqueda e IA (D67).
- **Todas las capas se compilan juntas.** La activación es por negocio, en tiempo de ejecución, con `tenant_modules`:
  - el guard responde 404 en las rutas de módulos inactivos;
  - el menú solo muestra lo activo.
- **Tablas con prefijo por módulo** (`pap_`, `fer_`, `tal_`, `crd_`), todas con `tenant_id` + RLS, en la carpeta única de migraciones.
- **Plantillas de giro:** al crear un negocio con `business_type` se activan sus módulos por defecto y se cargan unidades y categorías iniciales.
- **No** se carga código de terceros ni código dinámico. Los módulos los desarrolla el equipo del proyecto.

---

## 9. Lectura y reportes (CQRS ligero)

- **Escritura:** casos de uso del dominio (sección 6).
- **Lectura:** consultas SQL optimizadas (vistas o funciones `STABLE`), con `tenant_id` y sin lógica de negocio. Ejemplos: dashboard, rentabilidad, reposición, inversión.
- **Reglas de lectura:**
  - toda agregación se hace en SQL; nunca se descargan tablas para sumar en JS;
  - toda lista paginada usa `limit`/`offset` o cursor explícito; nunca se depende del tope implícito de 1000 filas;
  - catálogo para pantallas operativas con una **vista liviana**; la vista completa (FIFO y costos) solo para reportes.
- **Búsqueda de productos:** se queda en SQL (pgvector + trigram) como implementación del puerto `BuscadorProductos`.

---

## 10. Seguridad

1. El guard protege `/api/*` por defecto. Cada excepción declara su ruta, método y autenticación. Las rutas de revisión y administración de sesiones del agente exigen sesión del POS y permiso. Las del conector verifican su credencial propia. Los callbacks de Auth y el despachador interno tienen validación específica.
2. **`defineApiHandler({ role | permission, body, query }, fn)`** en todas las rutas:
   - exige rol o permiso;
   - valida la entrada con zod;
   - entrega `tenant` y `uow`;
   - traduce los errores de dominio a HTTP sin filtrar mensajes internos.
3. **Permisos por rol en el dominio** (p. ej. quién puede dar un descuento manual), no solo en el frontend. Los middlewares de página son solo UX.
4. **Defensa en profundidad:** RLS por negocio + rol `app_backend` sin bypass + permisos revocados a PostgREST.
5. **Secretos** solo en variables de entorno, sin valores por defecto en el código.
6. **Webhooks** con verificación de firma (HMAC).
7. **Test de aislamiento obligatorio en CI:** el negocio A no puede leer ni escribir datos del B, por ninguna ruta.

### 10.1 Matriz de permisos (D45, aprobada)

Se basa en lo que hoy hace el sistema:
- `create_sale` reserva a `owner`/`manager` el descuento manual, la venta a nombre de otro vendedor y la aprobación;
- las páginas de precios, mantenimiento, usuarios y reportes de rentabilidad ya son solo del dueño.

Los permisos se verifican en el dominio y en `defineApiHandler`; el frontend solo los usa para mostrar u ocultar.

| Permiso | Dueño | Encargado | Cajero |
|---|:-:|:-:|:-:|
| `sales.register` (vender) | ✓ | ✓ | ✓ |
| `sales.manual_discount` (descuento o precio manual) | ✓ | ✓ | — |
| `sales.on_behalf` (vender a nombre de otro) | ✓ | ✓ | — |
| `sales.approve` (aprobar una venta, D55) | ✓ | ✓ | — |
| `sales.void` (anular) | ✓ | ✓ | — |
| `returns.register` (devoluciones) | ✓ | ✓ | — |
| `cash.operate` (abrir y cerrar su caja) | ✓ | ✓ | ✓ |
| `cash.view_all` (ver todas las cajas y arqueos) | ✓ | ✓ | — |
| `products.view` | ✓ | ✓ | ✓ |
| `products.edit` | ✓ | ✓ | — |
| `pricing.edit` (reglas de precio) | ✓ | — | — |
| `purchases.register` | ✓ | ✓ | — |
| `inventory.count` (registrar conteo) | ✓ | ✓ | ✓ |
| `inventory.apply` (aplicar ajustes) | ✓ | ✓ | — |
| `customers.edit` | ✓ | ✓ | ✓ |
| `suppliers.edit` | ✓ | ✓ | — |
| `reports.sales` (ventas del día y del periodo) | ✓ | ✓ | — |
| `reports.costs` (costos, márgenes, rentabilidad) | ✓ | — | — |
| `users.manage` | ✓ | — | — |
| `settings.manage` (mantenimiento, módulos, configuración) | ✓ | — | — |

**Concesiones por usuario (D57):** además de su rol, el dueño puede conceder permisos puntuales a un usuario. El caso típico es `sales.manual_discount` para un cajero de confianza, que así puede fijar precios en ventas y pedidos. El permiso efectivo es `permisos del rol ∪ permisos concedidos`.

Los módulos agregan sus propios permisos en su manifiesto (p. ej. `school_lists.edit`) y asignan valores por defecto a cada rol.

---

## 11. Frontend

| Qué | Dónde |
|---|---|
| **Estado global del cliente** | **Pinia**: `useSessionStore` (usuario, negocio activo, rol, permisos), `useModulesStore` (módulos activos, menú), `useCartStore` (carrito POS, persistido), `useCashStore` (sesión de caja) |
| **Datos del servidor** | Composables por funcionalidad (`useProducts`, `useSalesHistory`…) sobre `useFetch`/`$fetch`. **No** se copian datos del servidor a Pinia: el store guarda estado de la sesión y del flujo, no cachés |
| **Componentes** | **Nuxt UI** como base (tablas, formularios, modales, notificaciones); iconos con Iconify. No se dibujan SVG a mano |
| **Utilidades** | **VueUse**: `useDebounce` en búsquedas, `useStorage` para el carrito, atajos de teclado, lector de código de barras |
| **Formularios** | Esquemas **zod compartidos** con el servidor |
| **Gráficos** | ECharts (`vue-echarts`) o Unovis |
| **Formato** | `utils/format.ts`: dinero, números, fechas, según `tenant_settings` |
| **Páginas** | Orquestan; la UI va en `components/<funcionalidad>/`. Límite orientativo: **500 líneas por archivo** |
| **Módulos** | Cada Layer trae sus páginas y componentes; el menú se arma desde los manifiestos activos |

---

## 12. Agente IA

- Módulo transversal `agent`, **hexagonal** (ya lo es hoy).
- **Canales** como adaptadores de entrada: Claude vía MCP (Yachay) y, a futuro, WhatsApp.
- **Registra a través de los casos de uso del núcleo** (`RegistrarVenta`, `ReservarStock`), nunca con RPC o tablas directas.
- **Estado (sesiones de vendedor, operaciones, reservas) en BD**, por negocio.
- **Credenciales por negocio:** el token del conector se reemplaza por credenciales emitidas por negocio.
- **Principio vigente:** la IA interpreta y el código verifica los hechos. No se fijan reglas de lenguaje en el código.
- **Un solo índice de embeddings** (`search_products_hybrid`). Se elimina `match_products`.

---

## 13. Estructura del repositorio

Estructura de **Nuxt 4** (D34): en cada capa, el código del cliente vive en `app/` y el del servidor en `server/`.

```text
nuxt.config.ts           aplicación final: extends de todas las capas
server/plugins/modules.ts  composición de manifiestos y adaptadores
layers/
  core/
    nuxt.config.ts
    app/                 pages/ components/ composables/ stores/ utils/
    server/
      contexts/
        identity/  catalog/  pricing/  inventory/  purchasing/  sales/
        customers/ suppliers/ settings/ reports/
      shared/
        domain/          Money, Quantity, TenantId, errores de dominio, eventos
        infrastructure/  db.ts (pool + UnitOfWork + set_config), outbox, auth
        http/            guard, defineApiHandler
      api/               adaptadores HTTP del núcleo
  modules/
    kits/  agent/         (quotes después de F9; credit y einvoice-pe a futuro)
  verticals/
    papeleria/  (ferreteria/  taller/  — a futuro)
shared/                  esquemas zod compartidos cliente/servidor (carpeta `shared/` de Nuxt 4)
supabase/
  migrations/            esquema, RLS, índices, consultas de lectura
  seed.sql               datos sintéticos para local, CI y staging
tests/
  unit/                  dominio puro
  integration/           casos de uso contra Supabase local
  characterization/      comportamiento de las RPC actuales (red durante la migración)
  isolation/             aislamiento entre negocios
AGENTS.md  CLAUDE.md     convenciones para agentes de IA
```

---

## 14. Plan de migración

El detalle de cada fase está en [`docs/fases/`](fases/README.md). **Ninguna fase empieza sin una validación previa**: se revisa contra el código real y lo aprendido en la fase anterior, y se ajusta (ver la regla en `fases/README.md`).

Se usa el **patrón Strangler**: un caso de uso a la vez, con la versión anterior como red de seguridad. Cada fase termina en algo desplegable y verificable.

**Alta del segundo negocio.** F6 acredita el flujo de cobro en staging. La apertura comercial exige completar la lista única de [F2 §1.2](fases/fase-2-multi-negocio.md#12-puerta-para-el-segundo-negocio), incluidos los canales accesibles y los módulos habilitados. La papelería sigue operando sola hasta entonces.

| Fase | Contenido | Terminada cuando |
|---|---|---|
| **0. Seguridad urgente** | `pnpm db:backup` previo; auth en `/api/school/*`; borrar `webhook/send-message` y el flujo WhatsApp; cerrar el registro público; bloquear el cambio de `role`; `requireOwner` en reportes, precios y mantenimiento; RLS en `stg_*` y cachés | Pruebas sin sesión → 401; un cajero no puede volverse dueño ni leer reportes |
| **1. Cimientos** | **Primero:** caracterizar los flujos en la versión vigente y validar Nuxt 4 + Tailwind 4 + Node 26 (D34), sin cambiar funcionalidad. **Luego:** estructura `layers/` vacía (D36); staging + `seed.sql` (D43); librería decimal y tipos `Money`/`Quantity` (D38); `AGENTS.md`/`CLAUDE.md`; ESLint + `vue-tsc` + `dependency-cruiser` en CI; Vitest (migrar `node --test`) + Playwright; Sentry; Renovate; guard + `defineApiHandler`; Drizzle + `app_backend` + `UnitOfWork`; outbox + despacho con `pg_cron`; Pinia (stores de sesión); Nuxt UI + VueUse instalados; `utils/format.ts`; borrar código muerto | Una ruta nueva sin declarar nada nace protegida; CI rompe ante una violación de capas; un error de producción llega a Sentry |
| **2. Multi-negocio (ventana de mantenimiento)** | `tenants`, `memberships`, `tenant_settings`, `tenant_modules`, `locations`; `tenant_id` en todas las tablas (papelería = negocio 1); RLS reescrita; claim `tenant_id` en el JWT; revocar `anon` (D46; `authenticated` al cerrar la Fase 7); `membership_permissions` (D57); test de aislamiento | Todo funciona igual para la papelería; el test de aislamiento pasa con un negocio de prueba |
| **3. Catálogo** | Contexto `catalog` hexagonal; `item_kind`; `attributes`; unidades y conversiones | Tests de caracterización de `upsert_product_catalog` y conversiones en verde contra la versión nueva |
| **4. Precios e impuestos** | Contexto `pricing`; impuestos; unificar el precio de listas escolares | `ResolverPrecio` reproduce `resolve_sale_item_pricing` en todos los casos de caracterización |
| **5. Compras e inventario** | `purchasing` + `inventory`: FIFO por ubicación, stock de una sola fuente, reservas, conteos atómicos, transferencias | Tests de caracterización + concurrencia en verde; stock y FIFO cuadran |
| **6. Ventas y caja** | Documento de venta, caja, anulación, devolución y registro por el agente. Retirar las RPC sustituidas tras verificar su paridad. | F6-T13 acredita el cobro idempotente y la conciliación en staging. Registrar el resultado en F2 §1.2. |
| **7. Reportes** | Consultas de lectura en SQL, multi-negocio, sin tope de 1000 filas; vista liviana del catálogo; índices; gráficos con ECharts/Unovis | El dashboard es correcto con más de 1000 ventas; los reportes responden en menos de 1 s |
| **8. Módulos** | Convertir a Layers: núcleo, `kits`, `agent` (estado en BD, `legacy` eliminado), vertical `papeleria` | La papelería funciona con sus módulos activos; otro negocio de prueba sin ellos no los ve |
| **9. Frontend** | Partir `sales.vue`, `utiles.vue`, `executive-profitability.vue`, `products.vue`, `combos.vue` usando componentes de Nuxt UI; carrito y caja en Pinia; búsqueda del POS con debounce; `xlsx` con carga diferida | Ninguna página pasa de unas 500 líneas; no quedan SVG de iconos a mano |

La Fase 9 puede avanzar en paralelo desde la Fase 1, pantalla por pantalla, conforme se toque cada una.

### Cómo se reemplaza cada caso de uso (fases 3 a 6)

1. Escribir **tests de caracterización** contra la RPC actual (Supabase local).
2. Implementar el dominio con **tests unitarios**.
3. Implementar el caso de uso y el adaptador; hacer que pasen los tests de caracterización.
4. Activar con un interruptor por caso de uso. Antes de volver al motor anterior, comprobar que reconoce las operaciones ya confirmadas y conserva sus efectos en caja, inventario y numeración. Cuando las garantías divergen, recuperar hacia adelante.
5. Tras un periodo estable, **eliminar** la RPC y el interruptor.

---

### Pendientes y entrega a la que afectan

| # | Pendiente | Bloquea |
|---|---|---|
| 1 | Verificar `git status` y el consumidor del reporte ejecutivo sobre la rama de trabajo. En `main` (`5b4f612`), `/api/reports/executive-profitability` está en uso. | Cambios que toquen el reporte |
| 2 | Comparar los archivos de la tarea con ramas pendientes. En `5b4f612` el reporte alternativo está en `claude/reportes-precios-escolares`. | Solo las tareas con conflicto |
| 3 | Registrar y comprobar `pnpm db:backup` antes de aplicar migraciones a la base real. | Publicación de migraciones |
| 4 | ~~Validar la matriz de permisos~~ — validada el 2026-11-18 | — |
| 5 | Desactivar el webhook de WhatsApp en Meta (D17). | Publicación de F0-T2 |
| 6 | Definir quién da la validación final del benchmark del selector `llm` (D19) | Fase 8 |
| 7 | Crear el proyecto Supabase de staging y su entorno en Vercel (D43) | Fase 2 |
| 8 | Verificar el plan comercial de Vercel para la primera tienda y la restauración con PITR para el segundo negocio (D44). | Operación comercial / alta del segundo negocio |

## 15. Trabajo con agentes de IA

Con un equipo pequeño y agentes de IA escribiendo buena parte del código, la arquitectura tiene que poder verificarse sola.

- **`AGENTS.md` (Codex) y `CLAUDE.md` (Claude)** con el mismo contenido: `AGENTS.md` es la fuente y `CLAUDE.md` lo importa (`@AGENTS.md`). La versión mínima se crea en la Fase 0 (F0-T0) y se amplía en la Fase 1 (F1-T11). Incluyen:
  - reglas de capas y de dependencia;
  - dónde va cada cosa;
  - cómo crear un caso de uso, una ruta y un módulo;
  - comandos de test.
- **Plantillas** para el contexto, el caso de uso, la ruta y el módulo, de modo que el agente copie la forma correcta en vez de inventarla.
- **Validaciones automáticas que bloquean el merge:** typecheck, lint, `dependency-cruiser`, tests unitarios, de integración y de aislamiento.
- **Tareas pequeñas:** una tarea = un caso de uso o una pantalla, con criterio de terminado verificable.
- **Revisión:** todo cambio en `domain/`, RLS o migraciones se revisa con `/code-review` antes del merge.

---

## 16. Qué se elimina

| Qué | Motivo |
|---|---|
| Los 41 archivos `server/modules/*/app/*` que solo reenvían y los `ports.ts` CRUD | Ceremonia |
| **Fase 0:** `whatsappFormatter.ts`, `whatsappMedia.ts`, `transcribeAudio.ts`, `schoolList.ts`, `api/webhook/*`, `api/utiles/modify-cart`, `api/utiles/embed-catalog`, y de `aiLogic.ts` solo `modifyCartCore` y `createSalesOrderFromWhatsApp`. **Fase 1:** `whatsapp_sessions` | WhatsApp (D17) |
| **Fase 8:** el resto de `aiLogic.ts`, `match_products`, `image_cache`, `match_cache`, `products.embedding` y su índice `ivfflat`, `scripts/embed-catalog.mjs` | IA duplicada; la lectura de listas por foto se reimplementa en el vertical papelería mediante los puertos compartidos de búsqueda e IA (D49, D67) |
| Modo `legacy` del agente y sus archivos | D19 |
| `stg_*_import`, `import_batches`, `result.json`, `data/*.csv`, `scripts/repair-uom-fifo.mjs` | Restos de importaciones pasadas |
| Funciones PL/pgSQL de negocio (`create_sale`, `create_purchase`, `resolve_sale_item_pricing`, `pay_sales_order`, guards…) | Reemplazadas por el dominio (fases 3–6) |
| `profiles.role` | La membresía asume el rol. Los helpers de identidad que siguen usando Auth o RLS se adaptan en F2. |

---

## 17. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| La reescritura del dominio cambia un resultado (precio, costo, stock) | Tests de caracterización antes de cada reemplazo + interruptor para volver atrás |
| Fuga de datos entre negocios | RLS + `app_backend` sin bypass + test de aislamiento en CI + alta del segundo negocio según F2 §1.2 |
| Inconsistencia de stock por concurrencia | `FOR UPDATE` en el dominio de inventario + test de concurrencia |
| Conexiones agotadas en serverless | Pooler Supavisor en modo transacción |
| Deriva de la arquitectura por agentes de IA | `AGENTS.md`/`CLAUDE.md`, plantillas y `dependency-cruiser` en CI |
| Migración multi-negocio con datos reales | Ventana planificada, respaldo previo, ensayo completo en staging |
| Alcance excesivo | Ferretería y taller **no** se construyen hasta tener clientes que lo validen; la papelería es el vertical de prueba |

---

## 18. Glosario

### 18.1 Casos de uso: nombre de negocio → nombre en código (D35)

| Negocio (este documento) | Código |
|---|---|
| RegistrarVenta / AnularVenta / RegistrarDevolucion | `registerSale` / `voidSale` / `registerReturn` |
| CrearPedido / CobrarPedido | `createOrder` / `payOrder` |
| AbrirCaja / CerrarCaja | `openCashSession` / `closeCashSession` |
| ResolverPrecio | `resolvePrice` |
| RegistrarCompra / CorregirCompra | `registerPurchase` / `correctPurchase` |
| RegistrarMovimiento / ConsumirFIFO | `recordStockMovement` / `consumeFifo` |
| ReservarStock / LiberarReserva / Transferir | `reserveStock` / `releaseReservation` / `transferStock` |
| IniciarConteo / AplicarConteo / CerrarConteo | `startCount` / `applyCount` / `closeCount` |
| GuardarProducto / ReemplazarConversiones / ConvertirUnidad | `saveProduct` / `replaceConversions` / `convertUnit` |
| CrearNegocio / InvitarUsuario / CambiarRol / ActivarModulo | `createTenant` / `inviteUser` / `changeRole` / `enableModule` |
| Dinero / Cantidad / Lote FIFO / Sesión de caja / Serie | `Money` / `Quantity` / `CostLayer` / `CashSession` / `DocumentSeries` |

### 18.2 Términos

- **Negocio / inquilino (tenant):** una empresa cliente de la plataforma. Sus datos están aislados de los demás.
- **Núcleo:** capacidades comunes a todo negocio.
- **Módulo transversal:** capacidad opcional útil para varios giros.
- **Módulo vertical:** capacidad propia de un giro.
- **Contexto:** área del núcleo con su propio modelo (ventas, inventario…).
- **Caso de uso:** una operación del negocio (RegistrarVenta).
- **Puerto / adaptador:** interfaz que el dominio necesita / su implementación concreta.
- **UnitOfWork:** transacción que envuelve un caso de uso.
- **Outbox:** tabla donde se guardan los eventos en la misma transacción, para entregarlos después de forma confiable.
- **Strangler:** reemplazar un sistema pieza por pieza mientras sigue funcionando.
