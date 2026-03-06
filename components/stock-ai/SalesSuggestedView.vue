<script setup lang="ts">
type Suggestion = {
  product_id: string
  sku: string | null
  name: string
  brand: string | null
  category: string
  unit: string
  stock_on_hand: number
  purchases_period_units: number
  sales_recorded_period_units: number
  adjust_out_period_units: number
  sales_period_units: number
  remaining_from_period_purchases: number
  reference_demand_units: number
  suggested_purchase_qty: number
  is_suggested: boolean
  estimated_unit_cost: number
  estimated_purchase_cost: number
}

type SuggestionReport = {
  scenario: {
    generated_at: string
    as_of_date: string
    base_period_start: string
    base_period_end_inclusive: string
    include_adjust_out_as_sales: boolean
  }
  summary: {
    analyzed_products: number
    suggested_products: number
    total_buy_units: number
    estimated_investment: number
  }
  suggestions: Suggestion[]
}

type StatusFilter = 'todos' | 'comprar' | 'monitorear'
type SupplierOption = {
  id: string
  name: string
}
type SuggestionSelection = {
  selected: boolean
  qty: number
  unit: string
}
type SelectedQuoteItem = {
  product_id: string
  qty: number
  unit_name: string
  cost_unit: number
  suggested_qty: number
  brand: string | null
  product_name: string
  sku: string | null
}

type ActiveQuote = {
  id: string
  supplier_id: string
  min_required_units: number
  status: string
  notes: string | null
  total_items: number
  total_units: number
  total_cost: number
  created_at: string
  updated_at: string
}

type ActiveQuoteItem = {
  id: string
  product_id: string
  qty: number
  suggested_qty: number
  unit_name: string
  cost_unit: number
  brand: string | null
  product_name: string | null
  sku: string | null
}

const loading = ref(false)
const savingQuote = ref(false)
const error = ref('')
const message = ref('')
const report = ref<SuggestionReport | null>(null)
const statusFilter = ref<StatusFilter>('todos')
const suppliers = ref<SupplierOption[]>([])
const selectedSupplierId = ref('')
const quoteNotes = ref('')
const saveModalOpen = ref(false)
const selectionByProduct = reactive<Record<string, SuggestionSelection>>({})
const activeQuote = ref<ActiveQuote | null>(null)
const activeQuoteItems = ref<ActiveQuoteItem[]>([])

const numberFormatter = new Intl.NumberFormat('es-PE', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 3
})

const moneyFormatter = new Intl.NumberFormat('es-PE', {
  style: 'currency',
  currency: 'PEN',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
})

const formatUnits = (value: number) => numberFormatter.format(Number(value || 0))
const formatMoney = (value: number) => moneyFormatter.format(Number(value || 0))
const normalizeUnit = (value: unknown) =>
  String(value || '')
    .trim()
    .toLowerCase() || 'unidad'

const toQty = (value: unknown, fallback = 1) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Number(parsed.toFixed(3)))
}

const quoteCode = (id: string) => String(id || '').slice(0, 8)

const generatedAtLabel = computed(() => {
  const raw = report.value?.scenario?.generated_at
  if (!raw) return '-'
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return '-'
  return new Intl.DateTimeFormat('es-PE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
})

const periodLabel = computed(() => {
  const start = report.value?.scenario?.base_period_start || '-'
  const end = report.value?.scenario?.base_period_end_inclusive || '-'
  return `${start} - ${end}`
})

const filteredSuggestions = computed(() => {
  const rows = report.value?.suggestions || []
  if (statusFilter.value === 'comprar') {
    return rows.filter((item) => item.is_suggested)
  }
  if (statusFilter.value === 'monitorear') {
    return rows.filter((item) => !item.is_suggested)
  }
  return rows
})

const statusFilterLabel = computed(() => {
  if (statusFilter.value === 'comprar') return 'Comprar ahora'
  if (statusFilter.value === 'monitorear') return 'Monitorear'
  return 'Todos'
})

const filteredSummary = computed(() => {
  const rows = filteredSuggestions.value
  return {
    products: rows.length,
    total_buy_units: rows.reduce((sum, item) => sum + Number(item.suggested_purchase_qty || 0), 0),
    estimated_investment: rows.reduce((sum, item) => sum + Number(item.estimated_purchase_cost || 0), 0)
  }
})

const ensureSelection = (item: Suggestion) => {
  const key = String(item.product_id || '')
  if (!selectionByProduct[key]) {
    selectionByProduct[key] = {
      selected: false,
      qty: toQty(item.suggested_purchase_qty || 1, 1),
      unit: normalizeUnit(item.unit)
    }
  }
  return selectionByProduct[key]
}

const selectedQuoteItems = computed<SelectedQuoteItem[]>(() => {
  const rows = report.value?.suggestions || []
  return rows
    .map((item) => {
      const selection = ensureSelection(item)
      if (!selection.selected) return null

      return {
        product_id: String(item.product_id || ''),
        qty: toQty(selection.qty, 1),
        unit_name: normalizeUnit(selection.unit || item.unit),
        cost_unit: Number(item.estimated_unit_cost || 0),
        suggested_qty: Number(item.suggested_purchase_qty || 0),
        brand: item.brand || null,
        product_name: String(item.name || 'Producto'),
        sku: item.sku || null
      }
    })
    .filter((item): item is SelectedQuoteItem => Boolean(item?.product_id))
})

const selectedQuoteUnits = computed(() =>
  selectedQuoteItems.value.reduce((sum, item) => sum + Number(item.qty || 0), 0)
)

const selectedQuoteCost = computed(() =>
  selectedQuoteItems.value.reduce((sum, item) => sum + Number(item.qty || 0) * Number(item.cost_unit || 0), 0)
)

const activeQuoteProductIds = computed(() => {
  const set = new Set<string>()
  activeQuoteItems.value.forEach((item) => {
    const id = String(item.product_id || '').trim()
    if (!id) return
    set.add(id)
  })
  return set
})

const isInActiveQuote = (productId: string) => activeQuoteProductIds.value.has(String(productId || '').trim())

const openSaveModal = () => {
  if (!selectedQuoteItems.value.length) return
  saveModalOpen.value = true
}

const closeSaveModal = () => {
  saveModalOpen.value = false
}

const syncSelectionsFromActiveQuote = () => {
  const rows = report.value?.suggestions || []
  const activeByProduct = new Map<string, ActiveQuoteItem>()
  activeQuoteItems.value.forEach((item) => {
    const productId = String(item.product_id || '').trim()
    if (!productId) return
    activeByProduct.set(productId, item)
  })

  rows.forEach((item) => {
    const selection = ensureSelection(item)
    const activeItem = activeByProduct.get(String(item.product_id || '').trim())

    if (!activeItem) {
      selection.selected = false
      if (Number(selection.qty || 0) <= 0) {
        selection.qty = toQty(item.suggested_purchase_qty || 1, 1)
      }
      selection.unit = normalizeUnit(selection.unit || item.unit)
      return
    }

    selection.selected = true
    selection.qty = toQty(activeItem.qty || item.suggested_purchase_qty || 1, 1)
    selection.unit = normalizeUnit(activeItem.unit_name || item.unit)
  })
}

const loadSuppliers = async () => {
  try {
    const data = await $fetch<{ suppliers: any[] }>('/api/suppliers')
    suppliers.value = (data.suppliers || [])
      .map((supplier) => ({
        id: String(supplier?.id || ''),
        name: String(supplier?.name || '').trim()
      }))
      .filter((supplier) => supplier.id && supplier.name)

    if (!selectedSupplierId.value && suppliers.value.length) {
      selectedSupplierId.value = suppliers.value[0].id
    }
  } catch (err: any) {
    error.value = err?.data?.statusMessage || err?.message || 'No se pudo cargar proveedores.'
  }
}

const loadActiveQuote = async () => {
  try {
    const data = await $fetch<{ quote: ActiveQuote | null; items: ActiveQuoteItem[] }>('/api/suppliers/quotes/active')
    activeQuote.value = data.quote || null
    activeQuoteItems.value = Array.isArray(data.items) ? data.items : []

    if (activeQuote.value?.supplier_id) {
      selectedSupplierId.value = activeQuote.value.supplier_id
    }
    quoteNotes.value = activeQuote.value?.notes || ''
  } catch (err: any) {
    error.value = err?.data?.statusMessage || err?.message || 'No se pudo cargar la cotización activa.'
  }
}

const saveSupplierQuote = async () => {
  error.value = ''
  message.value = ''

  if (!selectedSupplierId.value) {
    error.value = 'Selecciona un proveedor para guardar la cotización.'
    return
  }
  if (!selectedQuoteItems.value.length) {
    error.value = 'Selecciona al menos un producto en la columna Action.'
    return
  }

  savingQuote.value = true
  try {
    const result = await $fetch<{
      ok: boolean
      quote_id: string
      total_items: number
      total_units: number
      total_cost: number
    }>('/api/suppliers/quotes/create', {
      method: 'POST',
      body: {
        supplier_id: selectedSupplierId.value,
        min_required_units: 12,
        notes: quoteNotes.value || null,
        items: selectedQuoteItems.value
      }
    })

    message.value = `Cotización activa guardada. Código: ${String(result.quote_id || '').slice(0, 8)}`
    await loadActiveQuote()
    syncSelectionsFromActiveQuote()
    closeSaveModal()
  } catch (err: any) {
    error.value = err?.data?.statusMessage || err?.message || 'No se pudo guardar la cotización.'
  } finally {
    savingQuote.value = false
  }
}

watch(
  [() => report.value?.suggestions || [], () => activeQuoteItems.value],
  () => {
    syncSelectionsFromActiveQuote()
  },
  { immediate: true }
)

const loadReport = async () => {
  loading.value = true
  error.value = ''
  message.value = ''

  try {
    report.value = await $fetch<SuggestionReport>('/api/reports/sales-restock', {
      query: {
        as_of_date: '2026-03-09',
        limit: 5000
      }
    })
    message.value = 'Sugerencias actualizadas.'
  } catch (err: any) {
    error.value = err?.data?.statusMessage || err?.message || 'No se pudo cargar sugerencias.'
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  await Promise.all([loadReport(), loadSuppliers(), loadActiveQuote()])
})
</script>

<template>
  <div class="space-y-6 pb-20 xl:pb-8">
    <section class="ui-card">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 class="ui-heading">Sugeridos de compra por ventas</h2>
          <p class="ui-subtitle">
            Fecha de corte fija: 2026-03-09. Base: ventas acumuladas desde 2025-01-01 hasta esa fecha.
          </p>
        </div>

        <button class="ui-btn min-w-[180px]" :disabled="loading" @click="loadReport">
          {{ loading ? 'Calculando...' : 'Actualizar sugeridos' }}
        </button>
      </div>

      <div v-if="error" class="ui-alert-error mt-4">{{ error }}</div>
      <div v-else-if="message" class="ui-alert mt-4">{{ message }}</div>
    </section>

    <section v-if="report" class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      <article class="ui-card">
        <p class="text-xs font-semibold uppercase tracking-wide text-slate-400">Productos (filtro)</p>
        <p class="mt-2 text-3xl font-extrabold text-slate-800">{{ formatUnits(filteredSummary.products) }}</p>
      </article>

      <article class="ui-card">
        <p class="text-xs font-semibold uppercase tracking-wide text-slate-400">Unidades (filtro)</p>
        <p class="mt-2 text-3xl font-extrabold text-indigo-600">{{ formatUnits(filteredSummary.total_buy_units) }}</p>
      </article>

      <article class="ui-card">
        <p class="text-xs font-semibold uppercase tracking-wide text-slate-400">Inversión (filtro)</p>
        <p class="mt-2 text-2xl font-extrabold text-slate-800">{{ formatMoney(filteredSummary.estimated_investment) }}</p>
      </article>

      <article class="ui-card">
        <p class="text-xs font-semibold uppercase tracking-wide text-slate-400">Escenario</p>
        <p class="mt-2 text-sm font-bold text-slate-700">Fecha corte: {{ report.scenario.as_of_date }}</p>
        <p class="mt-1 text-xs text-slate-500">
          Filtro: {{ statusFilterLabel }}
        </p>
        <p class="mt-1 text-xs text-slate-500">
          Periodo base: {{ periodLabel }}
        </p>
        <p class="mt-1 text-xs text-slate-500">
          Ajustes salida suman en ventas: {{ report.scenario.include_adjust_out_as_sales ? 'Sí' : 'No' }}
        </p>
        <p class="mt-1 text-xs text-slate-500">
          Actualizado: {{ generatedAtLabel }}
        </p>
      </article>
    </section>

    <section v-if="report" class="ui-card">
      <div class="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div class="flex flex-wrap items-end gap-3">
          <label class="text-sm font-semibold text-slate-600">
            Filtrar por status
            <select v-model="statusFilter" class="ui-select mt-1 min-w-[220px]">
              <option value="todos">Todos</option>
              <option value="comprar">Comprar ahora</option>
              <option value="monitorear">Monitorear</option>
            </select>
          </label>

          <button
            class="ui-btn-secondary h-11 min-w-[170px]"
            :disabled="!selectedQuoteItems.length"
            @click="openSaveModal"
          >
            Save ({{ formatUnits(selectedQuoteItems.length) }})
          </button>
        </div>

        <p class="text-xs font-semibold text-slate-500">
          Mostrando {{ formatUnits(filteredSuggestions.length) }} ·
          Seleccionados {{ formatUnits(selectedQuoteItems.length) }} ·
          {{ formatMoney(selectedQuoteCost) }}
        </p>
        <p v-if="activeQuote" class="text-xs font-semibold text-emerald-600">
          Cotización activa #{{ quoteCode(activeQuote.id) }} · {{ formatUnits(activeQuote.total_items) }} items
        </p>
      </div>

      <div v-if="!filteredSuggestions.length" class="ui-empty-state">
        No hay productos sugeridos para este escenario.
      </div>

      <div v-else class="ui-table-wrap max-h-[72vh] overflow-auto">
        <table class="ui-table">
          <thead>
            <tr>
              <th>Action</th>
              <th>Estado</th>
              <th>Producto</th>
              <th>Stock actual</th>
              <th>Compras periodo</th>
              <th>Ventas caja periodo</th>
              <th>Ajustes salida periodo</th>
              <th>Ventas periodo</th>
              <th>Saldo compras-ventas</th>
              <th>Objetivo (ventas periodo)</th>
              <th>Cantidad sugerida</th>
              <th>Inversión</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in filteredSuggestions" :key="item.product_id">
              <td>
                <div class="flex items-center gap-2">
                  <input
                    v-model="ensureSelection(item).selected"
                    type="checkbox"
                    class="h-4 w-4 rounded border-slate-300"
                  />
                </div>
                <p v-if="isInActiveQuote(item.product_id)" class="mt-1 text-[11px] font-semibold text-emerald-600">
                  Ya en cotización activa
                </p>
              </td>
              <td>
                <span
                  :class="
                    item.is_suggested
                      ? 'inline-flex rounded-full bg-rose-100 px-2 py-1 text-xs font-bold text-rose-700'
                      : 'inline-flex rounded-full bg-slate-100 px-2 py-1 text-xs font-bold text-slate-600'
                  "
                >
                  {{ item.is_suggested ? 'Comprar ahora' : 'Monitorear' }}
                </span>
              </td>
              <td>
                <p class="font-semibold text-slate-800">{{ item.name }}</p>
                <p class="mt-1 text-xs text-slate-400">{{ item.brand || 'Sin marca' }}</p>
              </td>
              <td class="font-semibold text-slate-700">{{ formatUnits(item.stock_on_hand) }}</td>
              <td class="font-semibold text-slate-700">{{ formatUnits(item.purchases_period_units) }}</td>
              <td class="font-semibold text-slate-700">{{ formatUnits(item.sales_recorded_period_units) }}</td>
              <td class="font-semibold text-slate-700">{{ formatUnits(item.adjust_out_period_units) }}</td>
              <td class="font-semibold text-slate-700">{{ formatUnits(item.sales_period_units) }}</td>
              <td class="font-semibold text-slate-700">{{ formatUnits(item.remaining_from_period_purchases) }}</td>
              <td class="font-semibold text-slate-700">{{ formatUnits(item.reference_demand_units) }}</td>
              <td class="font-semibold text-indigo-700">{{ formatUnits(item.suggested_purchase_qty) }}</td>
              <td class="font-semibold text-slate-800">{{ formatMoney(item.estimated_purchase_cost) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <transition
      enter-active-class="transition duration-200"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition duration-150"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div v-if="saveModalOpen" class="fixed inset-0 z-[90]">
        <button class="absolute inset-0 bg-slate-900/55" aria-label="Cerrar modal" @click="closeSaveModal" />

        <div class="absolute inset-0 overflow-y-auto p-4 sm:p-6" @click.stop>
          <article
            class="mx-auto my-2 w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl sm:my-6 sm:p-6"
          >
            <header class="flex items-start justify-between gap-3">
              <div>
                <h3 class="text-lg font-extrabold text-slate-800">Guardar cotización</h3>
                <p class="mt-1 text-sm text-slate-500">
                  {{ formatUnits(selectedQuoteItems.length) }} productos ·
                  {{ formatUnits(selectedQuoteUnits) }} unidades ·
                  {{ formatMoney(selectedQuoteCost) }}
                </p>
              </div>
              <button class="ui-btn-secondary px-3 py-2 text-sm" @click="closeSaveModal">Cerrar</button>
            </header>

            <div class="mt-4 space-y-3">
              <label class="text-sm font-semibold text-slate-600">
                Proveedor
                <select v-model="selectedSupplierId" class="ui-select mt-1 w-full">
                  <option value="">Seleccionar proveedor</option>
                  <option v-for="supplier in suppliers" :key="`supplier-modal-${supplier.id}`" :value="supplier.id">
                    {{ supplier.name }}
                  </option>
                </select>
              </label>

              <label class="text-sm font-semibold text-slate-600">
                Nota (opcional)
                <input
                  v-model="quoteNotes"
                  type="text"
                  class="ui-input mt-1"
                  placeholder="Ejemplo: sugeridos corte 2026-03-09"
                />
              </label>
            </div>

            <div class="mt-5 flex justify-end gap-2">
              <button class="ui-btn-secondary" @click="closeSaveModal">Cancelar</button>
              <button
                class="ui-btn min-w-[180px]"
                :disabled="savingQuote || !selectedSupplierId || !selectedQuoteItems.length"
                @click="saveSupplierQuote"
              >
                {{ savingQuote ? 'Guardando...' : 'Guardar cotización' }}
              </button>
            </div>
          </article>
        </div>
      </div>
    </transition>
  </div>
</template>
