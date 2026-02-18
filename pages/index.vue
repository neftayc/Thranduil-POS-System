<script setup lang="ts">
const loading = ref(true)
const errorMessage = ref('')

const stats = reactive({
  activeProducts: 0,
  lowStock: 0,
  stockUnits: 0,
  stockValue: 0,
  potentialRevenue: 0,
  purchasesTotal: 0,
  purchasesCount: 0,
  salesTotal: 0,
  salesCount: 0,
  cogsTotal: 0,
  grossProfit: 0,
  netBalance: 0,
  marginPct: 0,
  avgTicket: 0
})

const lowStockItems = ref<any[]>([])

const moneyFormatter = new Intl.NumberFormat('es-PE', {
  style: 'currency',
  currency: 'PEN',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
})

const numberFormatter = new Intl.NumberFormat('es-PE', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2
})

const formatMoney = (value: number) => moneyFormatter.format(Number(value || 0))
const formatUnits = (value: number) => numberFormatter.format(Number(value || 0))

const criticalStockItems = computed(() => lowStockItems.value.slice(0, 6))

const coverageRatio = computed(() => {
  if (stats.stockValue <= 0) return 0
  return stats.potentialRevenue / stats.stockValue
})

const balanceStatus = computed(() => {
  if (stats.netBalance > 0) return { label: 'Flujo positivo', tone: 'text-emerald-500' }
  if (stats.netBalance < 0) return { label: 'Flujo en ajuste', tone: 'text-rose-500' }
  return { label: 'Flujo estable', tone: 'text-slate-500' }
})

const marginStatus = computed(() => {
  if (stats.marginPct >= 35) return { label: 'Margen saludable', tone: 'text-emerald-500' }
  if (stats.marginPct >= 20) return { label: 'Margen moderado', tone: 'text-amber-500' }
  return { label: 'Margen bajo', tone: 'text-rose-500' }
})

const loadStats = async () => {
  loading.value = true
  errorMessage.value = ''

  try {
    const data = await $fetch<{
      products: any[]
      purchases: any[]
      sales: any[]
      saleMovements: any[]
    }>('/api/dashboard/stats')

    const products = data.products || []
    const activeProducts = products.filter((item: any) => item.active !== false)

    const lowStock = activeProducts
      .filter((item: any) => Number(item.stock_on_hand || 0) <= Number(item.min_stock || 0))
      .sort((a: any, b: any) => Number(a.stock_on_hand || 0) - Number(b.stock_on_hand || 0))

    stats.activeProducts = activeProducts.length
    stats.lowStock = lowStock.length
    lowStockItems.value = lowStock

    stats.stockUnits = activeProducts.reduce(
      (sum: number, item: any) => sum + Number(item.stock_on_hand || 0),
      0
    )

    stats.stockValue = activeProducts.reduce(
      (sum: number, item: any) =>
        sum + Number(item.stock_on_hand || 0) * Number(item.avg_cost || 0),
      0
    )

    stats.potentialRevenue = activeProducts.reduce(
      (sum: number, item: any) =>
        sum + Number(item.stock_on_hand || 0) * Number(item.sale_price || 0),
      0
    )

    const purchases = data.purchases || []
    stats.purchasesCount = purchases.length
    stats.purchasesTotal = purchases.reduce(
      (sum: number, row: any) => sum + Number(row.total_cost || 0),
      0
    )

    const sales = data.sales || []
    stats.salesCount = sales.length
    stats.salesTotal = sales.reduce(
      (sum: number, row: any) => sum + Number(row.total || 0),
      0
    )

    const movements = data.saleMovements || []
    stats.cogsTotal = movements.reduce(
      (sum: number, row: any) =>
        sum + Math.abs(Number(row.qty || 0)) * Number(row.cost_unit || 0),
      0
    )

    stats.grossProfit = stats.salesTotal - stats.cogsTotal
    stats.netBalance = stats.salesTotal - stats.purchasesTotal
    stats.marginPct = stats.salesTotal > 0 ? (stats.grossProfit / stats.salesTotal) * 100 : 0
    stats.avgTicket = stats.salesCount > 0 ? stats.salesTotal / stats.salesCount : 0
  } catch (err: any) {
    errorMessage.value = err?.message || 'No se pudo cargar el dashboard.'
  } finally {
    loading.value = false
  }
}

onMounted(loadStats)
</script>

<template>
  <div class="space-y-8">
    <section class="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-4">
      <article class="card-hover rounded-2xl border border-gray-100 bg-white p-6 shadow-sm">
        <div class="mb-4 flex items-start justify-between">
          <div class="flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600">
            <svg class="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <span class="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-bold text-emerald-600">
            {{ loading ? '...' : `${stats.salesCount} ventas` }}
          </span>
        </div>
        <p class="mb-1 text-xs font-bold uppercase tracking-wider text-slate-400">Ingresos totales</p>
        <h3 class="text-3xl font-bold tracking-tight text-slate-800">{{ loading ? '...' : formatMoney(stats.salesTotal) }}</h3>
      </article>

      <article class="card-hover rounded-2xl border border-gray-100 bg-white p-6 shadow-sm">
        <div class="mb-4 flex items-start justify-between">
          <div class="flex h-12 w-12 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
            <svg class="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z" />
            </svg>
          </div>
          <span class="inline-flex items-center rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-bold text-blue-600">Hoy</span>
        </div>
        <p class="mb-1 text-xs font-bold uppercase tracking-wider text-slate-400">Compras registradas</p>
        <h3 class="text-3xl font-bold tracking-tight text-slate-800">{{ loading ? '...' : formatUnits(stats.purchasesCount) }}</h3>
      </article>

      <article class="card-hover rounded-2xl border border-gray-100 bg-white p-6 shadow-sm">
        <div class="mb-4 flex items-start justify-between">
          <div class="flex h-12 w-12 items-center justify-center rounded-xl bg-rose-50 text-rose-600">
            <svg class="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 12H4" />
            </svg>
          </div>
          <span class="inline-flex items-center rounded-full bg-rose-50 px-2.5 py-0.5 text-xs font-bold text-rose-600">Atención</span>
        </div>
        <p class="mb-1 text-xs font-bold uppercase tracking-wider text-slate-400">Stock crítico</p>
        <h3 class="text-3xl font-bold tracking-tight text-slate-800">{{ loading ? '...' : formatUnits(stats.lowStock) }}</h3>
      </article>

      <article class="relative overflow-hidden rounded-2xl bg-indigo-600 p-6 text-white shadow-lg shadow-indigo-500/30">
        <div class="absolute -top-10 -right-10 h-32 w-32 rounded-full bg-white/10 blur-2xl" />
        <div class="relative z-10">
          <div class="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-white/20">
            <svg class="h-6 w-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
            </svg>
          </div>
          <p class="mb-1 text-xs font-bold uppercase tracking-wider text-indigo-100">Objetivo mensual</p>
          <h3 class="text-3xl font-bold tracking-tight">{{ loading ? '...' : `${Math.max(0, Math.min(100, stats.marginPct)).toFixed(1)}%` }}</h3>
          <div class="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-black/20">
            <div
              class="h-full rounded-full bg-white"
              :style="{ width: `${Math.max(0, Math.min(100, stats.marginPct))}%` }"
            />
          </div>
        </div>
      </article>
    </section>

    <section class="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <article class="card-hover rounded-2xl bg-white p-8 shadow-sm lg:col-span-2">
        <div class="mb-8 flex items-center justify-between gap-4">
          <div>
            <h2 class="text-lg font-bold text-slate-800">Pulso financiero</h2>
            <p class="text-sm font-medium text-slate-400">Resumen operativo y rentabilidad del negocio.</p>
          </div>
          <span class="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-500">{{ loading ? '...' : balanceStatus.label }}</span>
        </div>

        <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <div class="rounded-xl border border-gray-100 bg-slate-50 p-4">
            <p class="text-xs font-bold uppercase tracking-wider text-slate-400">Utilidad bruta</p>
            <p class="mt-2 text-2xl font-bold" :class="stats.grossProfit < 0 ? 'text-rose-500' : 'text-slate-800'">
              {{ loading ? '...' : formatMoney(stats.grossProfit) }}
            </p>
          </div>
          <div class="rounded-xl border border-gray-100 bg-slate-50 p-4">
            <p class="text-xs font-bold uppercase tracking-wider text-slate-400">Ticket promedio</p>
            <p class="mt-2 text-2xl font-bold text-slate-800">{{ loading ? '...' : formatMoney(stats.avgTicket) }}</p>
          </div>
          <div class="rounded-xl border border-gray-100 bg-slate-50 p-4 sm:col-span-2 xl:col-span-1">
            <p class="text-xs font-bold uppercase tracking-wider text-slate-400">Cobertura de stock</p>
            <p class="mt-2 text-2xl font-bold text-indigo-600">{{ loading ? '...' : `${coverageRatio.toFixed(2)}x` }}</p>
          </div>
          <div class="rounded-xl border border-gray-100 bg-slate-50 p-4">
            <p class="text-xs font-bold uppercase tracking-wider text-slate-400">Inventario a costo</p>
            <p class="mt-2 text-xl font-bold text-slate-800">{{ loading ? '...' : formatMoney(stats.stockValue) }}</p>
          </div>
          <div class="rounded-xl border border-gray-100 bg-slate-50 p-4">
            <p class="text-xs font-bold uppercase tracking-wider text-slate-400">Potencial de venta</p>
            <p class="mt-2 text-xl font-bold text-indigo-600">{{ loading ? '...' : formatMoney(stats.potentialRevenue) }}</p>
          </div>
          <div class="rounded-xl border border-gray-100 bg-slate-50 p-4">
            <p class="text-xs font-bold uppercase tracking-wider text-slate-400">Balance neto</p>
            <p class="mt-2 text-xl font-bold" :class="stats.netBalance < 0 ? 'text-rose-500' : 'text-emerald-600'">
              {{ loading ? '...' : formatMoney(stats.netBalance) }}
            </p>
          </div>
        </div>
      </article>

      <article class="card-hover flex flex-col overflow-hidden rounded-2xl bg-white shadow-sm">
        <div class="border-b border-gray-100 p-6">
          <h3 class="text-lg font-bold text-slate-800">Reposición express</h3>
          <p class="mt-1 text-xs font-bold uppercase tracking-wide text-slate-400">Sugerencias inmediatas</p>
        </div>
        <div class="flex-1 space-y-3 overflow-y-auto p-4">
          <div
            v-for="item in criticalStockItems"
            :key="item.id"
            class="group flex items-center justify-between rounded-xl border border-transparent p-3 transition-all hover:border-indigo-100 hover:bg-slate-50"
          >
            <div class="min-w-0">
              <p class="truncate text-sm font-bold text-slate-800">{{ item.name }}</p>
              <p class="text-xs font-bold text-rose-600">Quedan {{ formatUnits(Number(item.stock_on_hand || 0)) }} u.</p>
            </div>
            <span class="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-gray-200 bg-white text-slate-400 transition-all group-hover:border-indigo-600 group-hover:bg-indigo-600 group-hover:text-white">
              +
            </span>
          </div>
          <div
            v-if="!criticalStockItems.length"
            class="rounded-xl border border-emerald-100 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-600"
          >
            No hay productos en nivel crítico.
          </div>
        </div>
        <div class="border-t border-gray-100 bg-slate-50 p-4">
          <NuxtLink to="/inventory" class="ui-btn-secondary w-full">Ver todo el inventario</NuxtLink>
        </div>
      </article>
    </section>

    <section class="ui-table-wrap">
      <div class="flex items-center justify-between border-b border-gray-100 p-6">
        <h3 class="text-lg font-bold text-slate-800">Resumen operativo</h3>
        <span class="text-sm font-bold text-indigo-600">{{ loading ? '...' : marginStatus.label }}</span>
      </div>
      <table class="ui-table">
        <thead>
          <tr>
            <th>Indicador</th>
            <th>Valor</th>
            <th>Detalle</th>
            <th>Estado</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td class="font-bold text-slate-700">Productos activos</td>
            <td class="font-bold text-slate-800">{{ loading ? '...' : formatUnits(stats.activeProducts) }}</td>
            <td>Catálogo habilitado para venta</td>
            <td><span class="ui-pill">Operativo</span></td>
          </tr>
          <tr>
            <td class="font-bold text-slate-700">Stock total</td>
            <td class="font-bold text-slate-800">{{ loading ? '...' : formatUnits(stats.stockUnits) }}</td>
            <td>Unidades disponibles en inventario</td>
            <td><span class="ui-pill">Disponible</span></td>
          </tr>
          <tr>
            <td class="font-bold text-slate-700">Compras acumuladas</td>
            <td class="font-bold text-slate-800">{{ loading ? '...' : formatMoney(stats.purchasesTotal) }}</td>
            <td>{{ loading ? '...' : `${stats.purchasesCount} registros` }}</td>
            <td><span class="inline-flex items-center rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-bold text-blue-600">Monitoreo</span></td>
          </tr>
          <tr>
            <td class="font-bold text-slate-700">Alertas de stock</td>
            <td class="font-bold text-rose-500">{{ loading ? '...' : formatUnits(stats.lowStock) }}</td>
            <td>Productos bajo mínimo definido</td>
            <td><span class="ui-pill ui-pill-low">Atención</span></td>
          </tr>
        </tbody>
      </table>
    </section>

    <div v-if="errorMessage" class="ui-alert-error">{{ errorMessage }}</div>
  </div>
</template>
