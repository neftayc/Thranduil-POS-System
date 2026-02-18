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
* **Framework:** **Vue 3** (Using Composition API for reusable logic hooks).
* **State Management:** **Pinia** (Critical for managing the active "Cart" state, discounts, and total calculations in real-time).
* **UI Kit:** Tailwind CSS for rapid, custom UI development.

### Backend & Data (Serverless)
* **BaaS:** **Supabase** (PostgreSQL) for real-time inventory updates via Websockets and auth management.

### 🤖 AI-Augmented Workflow
* *Copilot used extensively to generate complex TypeScript interfaces for transaction data models and inventory types.*

## ✨ Key Features
* [x] Real-time product search and filtering.
* [ ] **Dynamic Cart:** Add/remove items, apply line-item discounts, calculate tax instantly.
* [ ] **Sales hold:** Ability to "park" a sale and resume it later.
* [ ] **Daily Closing:** Generate Z-Report (end of day summary) for cash reconciliation.
* [ ] Inventory stock subtraction via Supabase triggers.

## 🚀 Development

```bash
pnpm install
pnpm run dev
