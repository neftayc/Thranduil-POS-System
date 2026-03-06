<script setup lang="ts">
definePageMeta({ middleware: ['owner'] })

type ProductProfitabilityStatus =
  | 'ganancia'
  | 'capital_recuperado'
  | 'perdida'
  | 'sin_movimiento'

type ProductProfitabilityItem = {
  product_id: string
  sku: string | null
  name: string
  brand: string | null
  category_name: string | null
  unit: string
  active: boolean
  stock_on_hand: number
  avg_cost: number
  purchase_total: number
  purchase_qty: number
  sales_recorded_total: number
  sales_recorded_qty: number
  sales_from_adjustment_total: number
  sales_from_adjustment_qty: number
  sales_total: number
  sales_qty: number
  balance: number
  margin_pct: number | null
  capital_recovered_pct: number
  inventory_value: number
  capital_pending: number
  capital_pending_after_stock: number
  capital_covered_with_stock: boolean
  status: ProductProfitabilityStatus
  last_purchase_at: string | null
  last_sale_at: string | null
  last_adjustment_at: string | null
}

type ProductProfitabilitySummary = {
  total_products: number
  with_sales: number
  with_purchases: number
  profitable: number
  breakeven: number
  loss: number
  no_movement: number
  purchases_total: number
  sales_recorded_total: number
  sales_from_adjustment_total: number
  sales_total: number
  balance_total: number
  inventory_value_total: number
}

type CategoryProfitabilitySummary = {
  category: string
  total_products: number
  purchases_total: number
  sales_total: number
  balance_total: number
  inventory_value_total: number
  capital_pending_total: number
  profitable: number
  breakeven: number
  loss: number
  no_movement: number
}

type ProductProfitabilityPeriodCode =
  | 'recovery_2025_to_2026_03_08'
  | 'standard_from_2026_03_09'

type ProductProfitabilityPeriodFilter = 'auto' | ProductProfitabilityPeriodCode

const loading = ref(false)
const message = ref('')
const generatedAt = ref<string | null>(null)
const rows = ref<ProductProfitabilityItem[]>([])
const selectedPeriod = ref<ProductProfitabilityPeriodFilter>('auto')
const reportPeriodCode = ref<ProductProfitabilityPeriodCode | null>(null)
const reportPeriodStart = ref<string | null>(null)
const reportPeriodEnd = ref<string | null>(null)
const adjustmentsCountedAsSales = ref(false)

const search = ref('')
const statusFilter = ref<'all' | ProductProfitabilityStatus>('all')
const activeFilter = ref<'all' | 'active' | 'inactive'>('all')
const movementFilter = ref<'all' | 'with-movement' | 'without-movement'>('all')
const categoryFilter = ref<'all' | string>('all')
const sortBy = ref<
  | 'balance-desc'
  | 'balance-asc'
  | 'pending-desc'
  | 'sales-desc'
  | 'purchases-desc'
  | 'recovery-desc'
>('pending-desc')

const moneyFormatter = new Intl.NumberFormat('es-PE', {
  style: 'currency',
  currency: 'PEN',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
})

const numberFormatter = new Intl.NumberFormat('es-PE', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 3
})

const percentFormatter = new Intl.NumberFormat('es-PE', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2
})

const formatMoney = (value: number) => moneyFormatter.format(Number(value || 0))
const formatNumber = (value: number) => numberFormatter.format(Number(value || 0))
const formatPercent = (value: number) => `${percentFormatter.format(Number(value || 0))}%`

const normalizeText = (value: any) =>
  String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()

const formatIsoDate = (value: string | null) => {
  if (!value) return ''
  const parts = value.split('-')
  if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`
  return value
}

const generatedAtLabel = computed(() => {
  if (!generatedAt.value) return ''
  const date = new Date(generatedAt.value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('es-PE', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date)
})

const periodRangeLabel = computed(() => {
  if (!reportPeriodStart.value) return ''
  if (!reportPeriodEnd.value) return `Desde ${formatIsoDate(reportPeriodStart.value)}`
  return `${formatIsoDate(reportPeriodStart.value)} al ${formatIsoDate(reportPeriodEnd.value)}`
})

const periodModeLabel = computed(() => {
  return adjustmentsCountedAsSales.value
    ? 'Modo recuperación: ventas = ventas registradas + ajustes negativos de inventario.'
    : 'Modo normal: ventas = solo ventas registradas (sin sumar ajustes de inventario).'
})

const periodCodeLabel = computed(() => {
  if (reportPeriodCode.value === 'recovery_2025_to_2026_03_08') return 'Recuperación 2025-2026'
  if (reportPeriodCode.value === 'standard_from_2026_03_09') return 'Operación normal'
  return ''
})

const statusLabel = (status: ProductProfitabilityStatus) => {
  if (status === 'ganancia') return 'Ganancia'
  if (status === 'capital_recuperado') return 'Capital recuperado'
  if (status === 'perdida') return 'En perdida'
  return 'Sin movimiento'
}

const statusClass = (status: ProductProfitabilityStatus) => {
  if (status === 'ganancia') return 'bg-emerald-50 text-emerald-700 border-emerald-200'
  if (status === 'capital_recuperado') return 'bg-blue-50 text-blue-700 border-blue-200'
  if (status === 'perdida') return 'bg-rose-50 text-rose-700 border-rose-200'
  return 'bg-slate-100 text-slate-600 border-slate-200'
}

const UNCATEGORIZED_LABEL = 'Sin categoria'

const categoryKey = (value: string) =>
  normalizeText(value)
    .replace(/\s+/g, ' ')
    .trim()

const categoryLabel = (item: ProductProfitabilityItem) => {
  const explicitCategory = String(item.category_name || '').trim()
  if (explicitCategory) return explicitCategory
  return UNCATEGORIZED_LABEL
}

const categoryFilterOptions = computed(() => {
  const buckets = new Map<string, { key: string; label: string; count: number }>()
  for (const item of rows.value) {
    const label = categoryLabel(item)
    const key = categoryKey(label)
    const current = buckets.get(key) || { key, label, count: 0 }
    current.count += 1
    buckets.set(key, current)
  }

  return Array.from(buckets.values()).sort((a, b) => a.label.localeCompare(b.label, 'es'))
})

const filteredRows = computed(() => {
  const term = normalizeText(search.value)
  const output = rows.value.filter((item) => {
    if (activeFilter.value === 'active' && !item.active) return false
    if (activeFilter.value === 'inactive' && item.active) return false

    const hasMovement = item.purchase_total > 0 || item.sales_total > 0
    if (movementFilter.value === 'with-movement' && !hasMovement) return false
    if (movementFilter.value === 'without-movement' && hasMovement) return false

    if (statusFilter.value !== 'all' && item.status !== statusFilter.value) return false
    if (categoryFilter.value !== 'all' && categoryFilter.value !== categoryKey(categoryLabel(item))) return false
    if (!term) return true

    const haystack = [item.name, item.sku, item.brand, item.unit, item.category_name, categoryLabel(item)]
      .map((part) => normalizeText(part))
      .join(' ')

    return haystack.includes(term)
  })

  output.sort((a, b) => {
    if (sortBy.value === 'balance-desc') return b.balance - a.balance
    if (sortBy.value === 'balance-asc') return a.balance - b.balance
    if (sortBy.value === 'sales-desc') return b.sales_total - a.sales_total
    if (sortBy.value === 'purchases-desc') return b.purchase_total - a.purchase_total
    if (sortBy.value === 'recovery-desc') return b.capital_recovered_pct - a.capital_recovered_pct
    return b.capital_pending - a.capital_pending
  })

  return output
})

const categorySummaryRows = computed(() => {
  const buckets = new Map<string, CategoryProfitabilitySummary>()

  for (const item of filteredRows.value) {
    const category = categoryLabel(item)
    const key = categoryKey(category)
    const current = buckets.get(key) || {
      category,
      total_products: 0,
      purchases_total: 0,
      sales_total: 0,
      balance_total: 0,
      inventory_value_total: 0,
      capital_pending_total: 0,
      profitable: 0,
      breakeven: 0,
      loss: 0,
      no_movement: 0
    }

    current.total_products += 1
    current.purchases_total += Number(item.purchase_total || 0)
    current.sales_total += Number(item.sales_total || 0)
    current.balance_total += Number(item.balance || 0)
    current.inventory_value_total += Number(item.inventory_value || 0)
    current.capital_pending_total += Number(item.capital_pending || 0)

    if (item.status === 'ganancia') current.profitable += 1
    else if (item.status === 'capital_recuperado') current.breakeven += 1
    else if (item.status === 'perdida') current.loss += 1
    else current.no_movement += 1

    buckets.set(key, current)
  }

  return Array.from(buckets.values())
    .map((row) => ({
      ...row,
      purchases_total: Number(row.purchases_total.toFixed(2)),
      sales_total: Number(row.sales_total.toFixed(2)),
      balance_total: Number(row.balance_total.toFixed(2)),
      inventory_value_total: Number(row.inventory_value_total.toFixed(2)),
      capital_pending_total: Number(row.capital_pending_total.toFixed(2))
    }))
    .sort((a, b) => {
      if (b.balance_total !== a.balance_total) return b.balance_total - a.balance_total
      if (b.sales_total !== a.sales_total) return b.sales_total - a.sales_total
      return a.category.localeCompare(b.category, 'es')
    })
})

const uncategorizedCount = computed(() => {
  return filteredRows.value.filter((item) => !String(item.category_name || '').trim()).length
})

const filteredSummary = computed(() => {
  return filteredRows.value.reduce(
    (acc, item) => {
      acc.total_products += 1
      if (item.purchase_total > 0) acc.with_purchases += 1
      if (item.sales_total > 0) acc.with_sales += 1
      if (item.status === 'ganancia') acc.profitable += 1
      else if (item.status === 'capital_recuperado') acc.breakeven += 1
      else if (item.status === 'perdida') acc.loss += 1
      else acc.no_movement += 1

      acc.purchases_total += item.purchase_total
      acc.sales_recorded_total += item.sales_recorded_total
      acc.sales_from_adjustment_total += item.sales_from_adjustment_total
      acc.sales_total += item.sales_total
      acc.balance_total += item.balance
      acc.inventory_value_total += item.inventory_value
      return acc
    },
    {
      total_products: 0,
      with_sales: 0,
      with_purchases: 0,
      profitable: 0,
      breakeven: 0,
      loss: 0,
      no_movement: 0,
      purchases_total: 0,
      sales_recorded_total: 0,
      sales_from_adjustment_total: 0,
      sales_total: 0,
      balance_total: 0,
      inventory_value_total: 0
    }
  )
})

const adjustmentSummary = computed(() => {
  return filteredRows.value.reduce(
    (acc, item) => {
      const qty = Number(item.sales_from_adjustment_qty || 0)
      if (qty > 0) {
        acc.adjusted_products += 1
      }
      acc.adjusted_qty += qty
      acc.adjusted_cost += qty * Number(item.avg_cost || 0)
      return acc
    },
    {
      adjusted_products: 0,
      adjusted_qty: 0,
      adjusted_cost: 0
    }
  )
})

const resetFilters = () => {
  search.value = ''
  statusFilter.value = 'all'
  activeFilter.value = 'all'
  movementFilter.value = 'all'
  categoryFilter.value = 'all'
  sortBy.value = 'pending-desc'
}

const loadData = async () => {
  loading.value = true
  message.value = ''

  try {
    const data = await $fetch<{
      generated_at: string
      period_code: ProductProfitabilityPeriodCode
      period_start: string
      period_end: string | null
      adjustments_counted_as_sales: boolean
      summary: ProductProfitabilitySummary
      items: ProductProfitabilityItem[]
    }>('/api/reports/product-profitability', {
      query:
        selectedPeriod.value === 'auto'
          ? undefined
          : { period: selectedPeriod.value }
    })

    generatedAt.value = data.generated_at || null
    reportPeriodCode.value = data.period_code || null
    reportPeriodStart.value = data.period_start || null
    reportPeriodEnd.value = data.period_end || null
    adjustmentsCountedAsSales.value = data.adjustments_counted_as_sales === true
    rows.value = data.items || []
  } catch (err: any) {
    message.value = err?.data?.statusMessage || err?.message || 'No se pudo cargar el reporte.'
  } finally {
    loading.value = false
  }
}

onMounted(loadData)
</script>

<template>
  <div class="space-y-6">
    <section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div class="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 class="text-xl font-bold text-slate-800">Rentabilidad por producto</h2>
          <p class="mt-1 text-sm text-slate-500">
            Compara compras acumuladas vs ventas acumuladas y revisa si cada producto ya recupero capital.
          </p>
          <p
            class="mt-1 text-xs font-medium"
            :class="adjustmentsCountedAsSales ? 'text-indigo-600' : 'text-emerald-700'"
          >
            {{ periodModeLabel }}
          </p>
          <p v-if="periodCodeLabel || periodRangeLabel" class="mt-1 text-xs font-medium text-slate-500">
            {{ periodCodeLabel }}<span v-if="periodCodeLabel && periodRangeLabel"> · </span>{{ periodRangeLabel }}
          </p>
          <p v-if="generatedAtLabel" class="mt-2 text-xs font-medium text-slate-400">
            Ultima actualizacion: {{ generatedAtLabel }}
          </p>
        </div>
        <div class="flex flex-wrap gap-2">
          <label class="min-w-[250px]">
            <span class="mb-1 block text-xs font-bold uppercase tracking-wide text-slate-400">Periodo</span>
            <select
              v-model="selectedPeriod"
              class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-100"
              :disabled="loading"
              @change="loadData"
            >
              <option value="auto">Periodo actual (automatico)</option>
              <option value="recovery_2025_to_2026_03_08">Recuperacion: 01/01/2025 - 08/03/2026</option>
              <option value="standard_from_2026_03_09">Normal: desde 09/03/2026</option>
            </select>
          </label>
          <button
            class="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-600 transition hover:bg-slate-50"
            type="button"
            :disabled="loading"
            @click="resetFilters"
          >
            Limpiar filtros
          </button>
          <button
            class="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
            type="button"
            :disabled="loading"
            @click="loadData"
          >
            {{ loading ? "Actualizando..." : "Actualizar reporte" }}
          </button>
        </div>
      </div>

      <p
        v-if="message"
        class="mt-4 rounded-lg border px-3 py-2 text-sm font-medium"
        :class="message.toLowerCase().includes('no se pudo') || message.toLowerCase().includes('error')
          ? 'border-rose-200 bg-rose-50 text-rose-600'
          : 'border-emerald-200 bg-emerald-50 text-emerald-700'"
      >
        {{ message }}
      </p>
    </section>

    <section class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <article class="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <p class="text-xs font-bold uppercase tracking-wide text-slate-400">Productos visibles</p>
        <p class="mt-2 text-3xl font-bold text-slate-800">{{ formatNumber(filteredSummary.total_products) }}</p>
        <p class="mt-1 text-xs font-medium text-slate-500">Con ventas: {{ formatNumber(filteredSummary.with_sales) }}</p>
      </article>

      <article class="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <p class="text-xs font-bold uppercase tracking-wide text-slate-400">Compras acumuladas</p>
        <p class="mt-2 text-3xl font-bold text-slate-800">{{ formatMoney(filteredSummary.purchases_total) }}</p>
        <p class="mt-1 text-xs font-medium text-slate-500">Con compras: {{ formatNumber(filteredSummary.with_purchases) }}</p>
      </article>

      <article class="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <p class="text-xs font-bold uppercase tracking-wide text-slate-400">Ventas acumuladas</p>
        <p class="mt-2 text-3xl font-bold text-slate-800">{{ formatMoney(filteredSummary.sales_total) }}</p>
        <p class="mt-1 text-xs font-medium text-slate-500">
          Registradas: {{ formatMoney(filteredSummary.sales_recorded_total) }} · Ajustes: {{ formatMoney(filteredSummary.sales_from_adjustment_total) }}
        </p>
      </article>

      <article class="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <p class="text-xs font-bold uppercase tracking-wide text-slate-400">Balance total</p>
        <p
          class="mt-2 text-3xl font-bold"
          :class="filteredSummary.balance_total >= 0 ? 'text-emerald-600' : 'text-rose-600'"
        >
          {{ formatMoney(filteredSummary.balance_total) }}
        </p>
        <p class="mt-1 text-xs font-medium text-slate-500">
          Ganan: {{ formatNumber(filteredSummary.profitable) }} · En perdida: {{ formatNumber(filteredSummary.loss) }}
        </p>
      </article>

      <article class="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:col-span-2 xl:col-span-4">
        <p class="text-xs font-bold uppercase tracking-wide text-slate-400">Ajustes de inventario en reporte</p>
        <p v-if="adjustmentsCountedAsSales" class="mt-2 text-sm font-semibold text-slate-700">
          Productos ajustados: {{ formatNumber(adjustmentSummary.adjusted_products) }} ·
          Cantidad ajustada: {{ formatNumber(adjustmentSummary.adjusted_qty) }} u ·
          Costo estimado: {{ formatMoney(adjustmentSummary.adjusted_cost) }}
        </p>
        <p v-else class="mt-2 text-sm font-semibold text-slate-500">
          En este periodo los ajustes de inventario no se suman como ventas.
        </p>
      </article>
    </section>

    <section class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div class="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-6">
        <label class="xl:col-span-2">
          <span class="mb-1 block text-xs font-bold uppercase tracking-wide text-slate-400">Buscar</span>
          <input
            v-model="search"
            type="text"
            class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-100"
            placeholder="Producto, sku, marca"
          />
        </label>

        <label>
          <span class="mb-1 block text-xs font-bold uppercase tracking-wide text-slate-400">Estado</span>
          <select
            v-model="statusFilter"
            class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-100"
          >
            <option value="all">Todos</option>
            <option value="ganancia">Ganancia</option>
            <option value="capital_recuperado">Capital recuperado</option>
            <option value="perdida">En perdida</option>
            <option value="sin_movimiento">Sin movimiento</option>
          </select>
        </label>

        <label>
          <span class="mb-1 block text-xs font-bold uppercase tracking-wide text-slate-400">Activo</span>
          <select
            v-model="activeFilter"
            class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-100"
          >
            <option value="all">Todos</option>
            <option value="active">Solo activos</option>
            <option value="inactive">Solo inactivos</option>
          </select>
        </label>

        <label>
          <span class="mb-1 block text-xs font-bold uppercase tracking-wide text-slate-400">Categoria</span>
          <select
            v-model="categoryFilter"
            class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-100"
          >
            <option value="all">Todas</option>
            <option
              v-for="option in categoryFilterOptions"
              :key="option.key"
              :value="option.key"
            >
              {{ option.label }} ({{ formatNumber(option.count) }})
            </option>
          </select>
        </label>

        <label>
          <span class="mb-1 block text-xs font-bold uppercase tracking-wide text-slate-400">Ordenar por</span>
          <select
            v-model="sortBy"
            class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-100"
          >
            <option value="pending-desc">Capital pendiente (desc)</option>
            <option value="balance-asc">Balance (mas negativo)</option>
            <option value="balance-desc">Balance (mas positivo)</option>
            <option value="sales-desc">Ventas usadas (desc)</option>
            <option value="purchases-desc">Compras (desc)</option>
            <option value="recovery-desc">% recuperado (desc)</option>
          </select>
        </label>
      </div>

      <div class="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          class="rounded-full border px-3 py-1 text-xs font-semibold transition"
          :class="movementFilter === 'all'
            ? 'border-indigo-200 bg-indigo-50 text-indigo-700'
            : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'"
          @click="movementFilter = 'all'"
        >
          Todos
        </button>
        <button
          type="button"
          class="rounded-full border px-3 py-1 text-xs font-semibold transition"
          :class="movementFilter === 'with-movement'
            ? 'border-indigo-200 bg-indigo-50 text-indigo-700'
            : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'"
          @click="movementFilter = 'with-movement'"
        >
          Con movimiento
        </button>
        <button
          type="button"
          class="rounded-full border px-3 py-1 text-xs font-semibold transition"
          :class="movementFilter === 'without-movement'
            ? 'border-indigo-200 bg-indigo-50 text-indigo-700'
            : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'"
          @click="movementFilter = 'without-movement'"
        >
          Sin movimiento
        </button>
      </div>
    </section>

    <section class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div class="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h3 class="text-base font-bold text-slate-800">Rentabilidad por categoria</h3>
          <p class="text-xs text-slate-500">
            {{ formatNumber(uncategorizedCount) }} productos visibles no tienen categoria asignada.
          </p>
        </div>
        <p class="text-xs font-medium text-slate-500">
          Categorias visibles: {{ formatNumber(categorySummaryRows.length) }}
        </p>
      </div>

      <div class="mt-3 overflow-x-auto">
        <table class="min-w-full divide-y divide-slate-200 text-sm">
          <thead class="bg-slate-50">
            <tr>
              <th class="px-4 py-3 text-left font-bold text-slate-600">Categoria</th>
              <th class="px-4 py-3 text-right font-bold text-slate-600">Productos</th>
              <th class="px-4 py-3 text-right font-bold text-slate-600">Compras</th>
              <th class="px-4 py-3 text-right font-bold text-slate-600">Ventas</th>
              <th class="px-4 py-3 text-right font-bold text-slate-600">Balance</th>
              <th class="px-4 py-3 text-right font-bold text-slate-600">Stock valorizado</th>
              <th class="px-4 py-3 text-right font-bold text-slate-600">Capital pendiente</th>
              <th class="px-4 py-3 text-right font-bold text-slate-600">Ganancia / Perdida</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            <tr v-if="!categorySummaryRows.length">
              <td colspan="8" class="px-4 py-6 text-center text-sm font-medium text-slate-400">
                No hay categorias para los filtros actuales.
              </td>
            </tr>
            <tr v-for="category in categorySummaryRows" :key="category.category">
              <td class="px-4 py-3 font-semibold text-slate-700">{{ category.category }}</td>
              <td class="px-4 py-3 text-right text-slate-600">{{ formatNumber(category.total_products) }}</td>
              <td class="px-4 py-3 text-right font-medium text-slate-700">{{ formatMoney(category.purchases_total) }}</td>
              <td class="px-4 py-3 text-right font-medium text-slate-700">{{ formatMoney(category.sales_total) }}</td>
              <td
                class="px-4 py-3 text-right font-semibold"
                :class="category.balance_total >= 0 ? 'text-emerald-600' : 'text-rose-600'"
              >
                {{ formatMoney(category.balance_total) }}
              </td>
              <td class="px-4 py-3 text-right text-slate-600">{{ formatMoney(category.inventory_value_total) }}</td>
              <td class="px-4 py-3 text-right text-slate-600">{{ formatMoney(category.capital_pending_total) }}</td>
              <td class="px-4 py-3 text-right text-xs text-slate-500">
                {{ formatNumber(category.profitable) }} / {{ formatNumber(category.loss) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div class="overflow-x-auto">
        <table class="min-w-full divide-y divide-slate-200 text-sm">
          <thead class="bg-slate-50">
            <tr>
              <th class="px-4 py-3 text-left font-bold text-slate-600">Producto</th>
              <th class="px-4 py-3 text-right font-bold text-slate-600">Compras</th>
              <th class="px-4 py-3 text-right font-bold text-slate-600">Ventas registradas</th>
              <th class="px-4 py-3 text-right font-bold text-slate-600">
                {{ adjustmentsCountedAsSales ? 'Ajuste inv. (cant/costo)' : 'Ajuste inv. (informativo)' }}
              </th>
              <th class="px-4 py-3 text-right font-bold text-slate-600">Balance</th>
              <th class="px-4 py-3 text-right font-bold text-slate-600">% recuperado</th>
              <th class="px-4 py-3 text-left font-bold text-slate-600">Estado</th>
              <th class="px-4 py-3 text-right font-bold text-slate-600">Stock valorizado</th>
              <th class="px-4 py-3 text-right font-bold text-slate-600">Capital pendiente</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            <tr v-if="loading">
              <td colspan="9" class="px-4 py-8 text-center text-sm font-medium text-slate-400">
                Cargando reporte...
              </td>
            </tr>

            <tr v-else-if="!filteredRows.length">
              <td colspan="9" class="px-4 py-8 text-center text-sm font-medium text-slate-400">
                No hay resultados para los filtros actuales.
              </td>
            </tr>

            <tr
              v-for="item in filteredRows"
              :key="item.product_id"
              class="transition hover:bg-slate-50"
            >
              <td class="px-4 py-3 align-top">
                <p class="font-semibold text-slate-800">{{ item.name }}</p>
                <p class="text-xs text-slate-500">
                  SKU: {{ item.sku || "Sin SKU" }} · {{ item.brand || "Sin marca" }}
                </p>
                <p class="mt-1 text-xs font-medium text-slate-500">
                  Categoria: {{ categoryLabel(item) }}
                </p>
                <p class="mt-1 text-xs text-slate-400">
                  Ult. compra: {{ item.last_purchase_at ? new Date(item.last_purchase_at).toLocaleDateString("es-PE") : "-" }}
                  · Ult. venta: {{ item.last_sale_at ? new Date(item.last_sale_at).toLocaleDateString("es-PE") : "-" }}
                </p>
                <p v-if="item.last_adjustment_at" class="mt-1 text-xs font-medium text-indigo-600">
                  Ult. ajuste considerado: {{ new Date(item.last_adjustment_at).toLocaleDateString("es-PE") }}
                </p>
              </td>

              <td class="px-4 py-3 text-right align-top">
                <p class="font-semibold text-slate-700">{{ formatMoney(item.purchase_total) }}</p>
                <p class="text-xs text-slate-500">{{ formatNumber(item.purchase_qty) }} {{ item.unit }}</p>
              </td>

              <td class="px-4 py-3 text-right align-top">
                <p class="font-semibold text-slate-700">{{ formatMoney(item.sales_recorded_total) }}</p>
                <p class="text-xs text-slate-500">{{ formatNumber(item.sales_recorded_qty) }} {{ item.unit }}</p>
                <p class="text-xs text-slate-400">Solo ventas de caja</p>
              </td>

              <td class="px-4 py-3 text-right align-top">
                <p class="font-semibold text-slate-700">{{ formatNumber(item.sales_from_adjustment_qty) }} {{ item.unit }}</p>
                <p v-if="adjustmentsCountedAsSales" class="text-xs font-medium text-indigo-600">
                  Venta est.: {{ formatMoney(item.sales_from_adjustment_total) }}
                </p>
                <p v-else class="text-xs text-slate-400">No suma a ventas</p>
                <p class="text-xs text-slate-500">
                  Costo: {{ formatMoney(Number(item.sales_from_adjustment_qty || 0) * Number(item.avg_cost || 0)) }}
                </p>
              </td>

              <td class="px-4 py-3 text-right align-top">
                <p class="font-semibold" :class="item.balance >= 0 ? 'text-emerald-600' : 'text-rose-600'">
                  {{ formatMoney(item.balance) }}
                </p>
                <p class="text-xs text-slate-500">
                  Ventas usadas: {{ formatMoney(item.sales_total) }}
                </p>
                <p class="text-xs text-slate-500">
                  Margen:
                  {{
                    item.margin_pct === null
                      ? "-"
                      : formatPercent(item.margin_pct)
                  }}
                </p>
              </td>

              <td class="px-4 py-3 text-right align-top">
                <p class="font-semibold text-slate-700">{{ formatPercent(item.capital_recovered_pct) }}</p>
                <div class="mt-2 h-1.5 w-full rounded-full bg-slate-100">
                  <div
                    class="h-1.5 rounded-full bg-indigo-500"
                    :style="{ width: `${Math.max(0, Math.min(100, item.capital_recovered_pct))}%` }"
                  />
                </div>
              </td>

              <td class="px-4 py-3 align-top">
                <span
                  class="inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold"
                  :class="statusClass(item.status)"
                >
                  {{ statusLabel(item.status) }}
                </span>
                <p v-if="item.capital_covered_with_stock" class="mt-1 text-xs font-semibold text-indigo-600">
                  Capital cubierto con stock actual
                </p>
              </td>

              <td class="px-4 py-3 text-right align-top">
                <p class="font-semibold text-slate-700">{{ formatMoney(item.inventory_value) }}</p>
                <p class="text-xs text-slate-500">
                  {{ formatNumber(item.stock_on_hand) }} {{ item.unit }} · Costo: {{ formatMoney(item.avg_cost) }}
                </p>
              </td>

              <td class="px-4 py-3 text-right align-top">
                <p class="font-semibold text-slate-700">{{ formatMoney(item.capital_pending) }}</p>
                <p class="text-xs text-slate-500">
                  Pendiente neto: {{ formatMoney(item.capital_pending_after_stock) }}
                </p>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
