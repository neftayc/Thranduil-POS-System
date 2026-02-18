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

## Configuracion rapida

1. Crea un proyecto en Supabase.
2. En el SQL Editor, ejecuta el script:
   - `supabase/schema.sql`
3. Copia `.env.example` a `.env` y completa tus claves:
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

## Migracion desde version anterior

- Si ya ejecutaste una version previa del esquema, vuelve a ejecutar `supabase/schema.sql`.
- El script sincroniza datos legacy:
  - `products.sale_price` -> `product_prices`
  - `products.stock_on_hand`, `products.avg_cost`, `products.min_stock` -> `inventory_balances`

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
