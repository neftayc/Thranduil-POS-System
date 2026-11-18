<div align="center">
  <img src="LINK_A_TU_SCREENSHOT_DEL_POS" width="100%" style="border-radius: 10px" alt="POS System Banner" />
  <h1>🛍️ Thranduil POS System</h1>
  <h3>Modern Point of Sale Application for Retail</h3>
</div>

---

## 💡 The Problem

The stationery physical store needed a modern, agile interface to manage daily sales, track real-time inventory, and generate end-of-day cash reports, replacing outdated legacy software.

## 🎯 The Solution

A Single Page Application (SPA) optimized for tablet and desktop use, focusing on speed of transaction and real-time state synchronization.

## Desarrollo del refactor

La [arquitectura propuesta](docs/arquitectura.md) define el stack objetivo y los contratos de sesión, permisos, inventario, ventas y caja. El [plan de fases](docs/fases/README.md) indica la primera tarea de desarrollo y sus criterios de aceptación.

## 🏗️ Tech Stack & Key Decisions

### Frontend (Client-Heavy Logic)

- **Framework:** **Vue 3** (Using Composition API for reusable logic hooks).
- **State management:** the current POS manages cart state in Vue. The refactor introduces Pinia for the session, cart and cash register in stages.
- **UI Kit:** Tailwind CSS for rapid, custom UI development.

### Backend & Data (Serverless)

- **BaaS:** **Supabase** (PostgreSQL) for real-time inventory updates via Websockets and auth management.

### 🤖 AI-Augmented Workflow

- _Copilot used extensively to generate complex TypeScript interfaces for transaction data models and inventory types._

## ✨ Key Features

- [x] Real-time product search and filtering.
- [ ] **Dynamic Cart:** Add/remove items, apply line-item discounts, calculate tax instantly.
- [ ] **Sales hold:** Ability to "park" a sale and resume it later.
- [ ] **Daily Closing:** Generate Z-Report (end of day summary) for cash reconciliation.
- [ ] Inventory stock subtraction via Supabase triggers.

## 🚀 Development

# Papeleria (Nuxt + Supabase)

Sistema para registrar productos, inventario, ventas, compras, clientes y usuarios.

## Requisitos

- Node.js 20.11+
- Cuenta y proyecto en Supabase

## Base de datos y entornos

El esquema vive en `supabase/migrations/` (Supabase CLI). La primera migracion,
`20261116120000_baseline.sql`, es el esquema real de produccion al 2026-11-16.
Los SQL anteriores (schema.sql, fix_*, patch_*, import_*) estan en `supabase/archive/`
solo como historial: no se ejecutan.

Entornos: **local** (Docker, tu computadora) y **produccion** (Supabase + Vercel).

### Comandos

| Comando | Que hace |
|---|---|
| `pnpm db:start` / `pnpm db:stop` | Enciende / apaga Supabase local (los datos se conservan) |
| `pnpm db:new nombre` | Crea una migracion nueva en `supabase/migrations/` |
| `pnpm db:reset` | Reconstruye la base local desde las migraciones y carga la ultima copia de produccion |
| `pnpm db:refresh` | Respalda produccion y trae esa copia fresca a local |
| `pnpm db:backup` | Respalda produccion en `~/papeleria-backups/` |
| `pnpm db:pending` | Muestra que migraciones le faltan a produccion (solo lectura) |
| `pnpm db:release` | Publica: aplica migraciones en produccion y luego sube el codigo a `main` |

### Flujo de un cambio (de local a produccion)

1. Crea una rama: `git switch -c mi-cambio`.
2. `pnpm db:start`, y si cambias la base: `pnpm db:new nombre` y escribe el SQL.
3. `pnpm db:reset` y prueba en `pnpm dev`. Haz commit.
4. `git push -u origin mi-cambio`: la revision automatica de GitHub (CI) aplica todas las
   migraciones en una base temporal, revisa las funciones SQL, compila y corre los tests.
5. Cuando la revision pase: `pnpm db:release` desde tu rama. Hace, en este orden:
   revisa que la rama tenga lo ultimo de `main` y que la revision de GitHub paso; prueba en local;
   respalda produccion; aplica las migraciones (pide escribir `produccion`); sube los commits a
   `main` (pide escribir `publicar`).
6. Publica la app a mano: `pnpm dlx vercel --prod` (el deploy automatico esta apagado por ahora).

Primero la base, despues la app: por eso no se sube a `main` a mano cuando hay migraciones.
Las migraciones deben ser compatibles con la version anterior de la app (agregar columnas o
funciones si; borrar o renombrar se hace en dos publicaciones).

### Vercel
- **Deploy automatico apagado por ahora.** `vercel.json` (`ignoreCommand`) cancela cualquier build
  que venga de GitHub, incluida `main`. La app se publica solo a mano con `pnpm dlx vercel --prod`.
- Para encenderlo: conectar el repo en Vercel (Settings -> Git, rama de produccion `main`) y cambiar
  `ignoreCommand` a `[ -n "$VERCEL_GIT_COMMIT_REF" ] && [ "$VERCEL_GIT_COMMIT_REF" != "main" ]`
  (publica solo `main`; las demas ramas no, asi ninguna rama de prueba escribe en la base real).
- Variables de entorno de Production: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE`
  y el resto de `.env.production.local`.

### Reglas
- Ningun cambio se ejecuta a mano en produccion: todo es una migracion (tambien las reparaciones de datos).
- Nunca se edita una migracion que ya se aplico en produccion: se crea otra.
- Rollbacks de migraciones arriesgadas en `supabase/rollbacks/`.
- En local, `.env` apunta a Supabase local (`APP_ENV=local`); la configuracion de produccion
  vive en `.env.production.local` (no se commitea).

## Configuracion rapida

1. Levanta Supabase local (`supabase start`) o vincula un proyecto (`supabase link`).
2. Copia `.env.example` a `.env` y completa tus claves:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE` (necesario para gestion de usuarios)
   - `NUXT_PUBLIC_APP_NAME` (opcional)

Nota: la app consume Supabase solo desde el backend (endpoints en `server/api/*`) usando cookies httpOnly para la sesion.

## Modelo de datos (estandar)

- `products`: catalogo base del producto
- `product_prices`: historial y precio actual de venta
- `inventory_balances`: stock disponible, costo promedio y stock minimo
- `stock_movements`: movimientos (compra, venta, ajuste)

## Instalacion

```bash
npm install
npm run dev
```

## Deployment en Vercel

Este proyecto usa Nuxt con endpoints en `server/api/*`, por lo que debe desplegarse como app con runtime (no solo estatico).

### 1) Preparar variables de entorno en Vercel

Configura estas variables en **Production** (y tambien en **Preview** si lo deseas):

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE`
- `NUXT_PUBLIC_APP_NAME` (opcional)

### 2) Deploy por CLI

```bash
nvm use
corepack enable
pnpm dlx vercel login
pnpm dlx vercel link
pnpm dlx vercel --prod
```

### 3) Deploy por Dashboard (alternativa)

- Crea un proyecto en Vercel e importa este repo/codigo.
- Framework: Nuxt.js (auto-detectado).
- Build command: `pnpm build`
- Install command: `pnpm install --frozen-lockfile`
- Agrega las variables de entorno y ejecuta deploy.

## Primer usuario

El esquema actual asigna `owner` al primer perfil y `cashier` a los siguientes. F0 cierra el registro público y documenta el alta inicial controlada. En F2 el rol comercial pasa a la membresía de cada negocio. El primer dueño de una tienda y el administrador de plataforma se aprovisionan por separado. [Arranque y primer acceso](docs/fases/fase-0-seguridad.md).

## Gestion de usuarios

- El owner puede crear usuarios y asignar roles en **Usuarios**.
- Para esto necesitas `SUPABASE_SERVICE_ROLE` en el `.env`.

## Importar productos desde Excel

- Ve a **Productos** y usa el importador.
- El importador detecta automaticamente hojas y columnas comunes como:
  - `ID de articulo`, `Nombre del elemento`, `Tipo`, `Marca`
  - `Unidad Medida` o `Unidad de Venta`
  - `Precio por Unidad`, `Precio de Venta Sugerido`
  - `Count`, `Stock`, `Cantidad` o `#`

## Operacion basica

- **Productos** actualiza catalogo (`products`), precio actual (`product_prices`) y configuracion de inventario (`inventory_balances`).
- **Compras** aumentan stock y recalculan costo promedio.
- **Ventas** descuentan stock y aplican reglas automaticas (tipo de cliente, presentacion, mayorista y promociones).
- **Reglas de venta** permite configurar precios por tipo de cliente, presentacion, escalas mayoristas y promociones temporales.
- **Inventario** muestra stock, costo promedio y valor estimado desde `product_catalog`.

## Integración MCP mediante Yachay

Los vendedores registran ventas por voz o texto desde Claude con su propio usuario
del POS: eligen el sistema, aprueban un código en `/vincular` y dictan el pedido.
El contrato HTTP, la identificación del vendedor, las ventas por confirmar y las
pruebas se describen en [docs/yachay-agent-api.md](docs/yachay-agent-api.md).
El conector Python está en `integrations/yachay-connector`.
