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

## 🏗️ Tech Stack & Key Decisions

### Frontend (Client-Heavy Logic)

- **Framework:** **Vue 3** (Using Composition API for reusable logic hooks).
- **State Management:** **Pinia** (Critical for managing the active "Cart" state, discounts, and total calculations in real-time).
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

Entornos: **local** (Docker, `supabase start`), **staging** y **produccion**.

```bash
supabase start                 # levanta Supabase local (API en http://127.0.0.1:54321)
supabase db reset --local      # reconstruye la base local desde las migraciones
supabase migration new nombre  # nueva migracion (siempre asi, nunca SQL a mano en produccion)
supabase db push --linked      # aplica en el proyecto vinculado, tras probar en local
```

Reglas:
- Ningun cambio de esquema se ejecuta a mano en produccion: todo es una migracion.
- Cada migracion se prueba en local (`db reset`) antes de `db push`.
- Respaldo de produccion (`supabase db dump --linked`) antes de cada `db push`.
- Rollbacks de migraciones arriesgadas en `supabase/rollbacks/`.

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

- El primer usuario que se registre sera `owner` automaticamente.
- Los siguientes usuarios se crean como `cashier`.

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
