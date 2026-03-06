<script setup lang="ts">
type PriorityLevel = 'critica' | 'alta' | 'media' | 'baja'

type RestockRecommendation = {
  product_id: string
  sku: string | null
  name: string
  category: string
  brand: string | null
  unit: string
  stock_on_hand: number
  min_stock: number
  avg_cost: number
  sale_price: number
  school_lists_count: number
  school_units_per_set: number
  campaign_demand_units: number
  recent_sales_units: number
  avg_daily_sales: number
  velocity_demand_units: number
  safety_stock_units: number
  target_stock_units: number
  suggested_purchase_qty: number
  estimated_unit_cost: number
  estimated_purchase_cost: number
  expected_revenue: number
  potential_gross_margin: number
  coverage_days: number | null
  priority: PriorityLevel
  priority_score: number
  reasons: string[]
  agents: {
    stock_risk_score: number
    campaign_pressure_score: number
    velocity_score: number
    margin_score: number
  }
}

type RestockReport = {
  scenario: {
    generated_at: string
    min_required_units: number
    fallback_cost_factor: number
  }
  summary: {
    analyzed_products: number
    products_linked_to_lists: number
    suggested_products: number
    critical_count: number
    high_count: number
    medium_count: number
    low_count: number
    stockouts_now: number
    total_buy_units: number
    estimated_investment: number
    expected_revenue: number
    expected_margin: number
    lists_considered: number
    linked_items_considered: number
  }
  overview: string
  recommendations: RestockRecommendation[]
}

type ProductSelection = {
  selected: boolean
  qty: number
  unit: string
}

type SupplierOption = {
  id: string
  name: string
}

type SelectedQuoteItem = {
  product_id: string
  qty: number
  unit_name: string
  cost_unit: number
  suggested_qty: number
  product_name: string
  sku: string | null
}

type CategoryCard = {
  key: string
  label: string
  items: RestockRecommendation[]
  products_count: number
  selected_count: number
  selected_units: number
  selected_investment: number
  suggested_investment: number
}

type StockAiTab = 'alerta' | 'cotizaciones' | 'sugeridos'

const route = useRoute()
const router = useRouter()

const scenario = reactive({
  min_required_units: 12
})

const loading = ref(false)
const savingQuote = ref(false)
const error = ref('')
const message = ref('')
const report = ref<RestockReport | null>(null)
const categoryModalOpen = ref(false)
const activeCategoryKey = ref('')
const modalSearch = ref('')
const suppliers = ref<SupplierOption[]>([])
const selectedSupplierId = ref('')
const quoteNotes = ref('')

const selectionByProduct = reactive<Record<string, ProductSelection>>({})

const normalizeTab = (value: unknown): StockAiTab => {
  const raw = String(value || '').trim().toLowerCase()
  if (raw === 'cotizaciones') return 'cotizaciones'
  if (raw === 'sugeridos') return 'sugeridos'
  return 'alerta'
}

const activeTab = computed<StockAiTab>(() => normalizeTab(route.query.tab))

const tabClass = (tab: StockAiTab) =>
  activeTab.value === tab
    ? 'rounded-xl border border-indigo-300 bg-indigo-50 px-4 py-2 text-sm font-bold text-indigo-700'
    : 'rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-600 hover:border-indigo-200 hover:text-indigo-700'

const setTab = async (tab: StockAiTab) => {
  const query = { ...route.query } as Record<string, any>
  if (tab === 'alerta') {
    delete query.tab
  } else {
    query.tab = tab
  }
  await router.replace({ query })
}

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
const toInt = (value: unknown, fallback = 1) => {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.max(1, Math.trunc(num))
}

const recommendations = computed(() => report.value?.recommendations || [])

const selectedQuoteItems = computed<SelectedQuoteItem[]>(() =>
  recommendations.value
    .map((item) => {
      const selection = ensureSelection(item)
      const qty = toInt(selection.qty, 1)
      if (!selection.selected || qty <= 0) return null

      return {
        product_id: String(item.product_id || ''),
        qty,
        unit_name: String(selection.unit || item.unit || 'unidad')
          .trim()
          .toLowerCase() || 'unidad',
        cost_unit: Number(item.estimated_unit_cost || 0),
        suggested_qty: Number(item.suggested_purchase_qty || 0),
        product_name: String(item.name || 'Producto'),
        sku: item.sku || null
      }
    })
    .filter((item): item is SelectedQuoteItem => Boolean(item?.product_id))
)

const selectedQuoteUnits = computed(() =>
  selectedQuoteItems.value.reduce((sum, item) => sum + Number(item.qty || 0), 0)
)

const ensureSelection = (item: RestockRecommendation) => {
  const key = String(item.product_id || '')
  if (!selectionByProduct[key]) {
    selectionByProduct[key] = {
      selected: false,
      qty: toInt(item.suggested_purchase_qty || 1, 1),
      unit: String(item.unit || 'unidad')
    }
  }
  return selectionByProduct[key]
}

const sanitizeQty = (item: RestockRecommendation) => {
  const selection = ensureSelection(item)
  selection.qty = toInt(selection.qty, 1)
}

const unitOptions = (item: RestockRecommendation) => {
  const options = [String(item.unit || '').trim(), 'unidad', 'paquete', 'caja']
    .filter(Boolean)
    .map((value) => value.toLowerCase())

  return Array.from(new Set(options))
}

const lineInvestment = (item: RestockRecommendation) => {
  const selection = ensureSelection(item)
  if (!selection.selected) return 0
  return Number(selection.qty || 0) * Number(item.estimated_unit_cost || 0)
}

const normalizeCategoryKey = (value: string) =>
  String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

const categoryCards = computed<CategoryCard[]>(() => {
  const grouped = new Map<string, { label: string; items: RestockRecommendation[] }>()

  recommendations.value.forEach((item) => {
    const label = String(item.category || 'Sin categoria').trim() || 'Sin categoria'
    const key = normalizeCategoryKey(label) || 'sin categoria'
    const bucket = grouped.get(key) || { label, items: [] }
    bucket.items.push(item)
    grouped.set(key, bucket)
  })

  const cards = Array.from(grouped.entries()).map(([key, bucket]) => {
    const items = bucket.items
    let selectedCount = 0
    let selectedUnits = 0
    let selectedInvestment = 0
    let suggestedInvestment = 0

    items.forEach((item) => {
      suggestedInvestment += Number(item.estimated_purchase_cost || 0)

      const selection = ensureSelection(item)
      if (!selection.selected) return

      selectedCount += 1
      selectedUnits += toInt(selection.qty, 1)
      selectedInvestment += lineInvestment(item)
    })

    return {
      key,
      label: bucket.label,
      items,
      products_count: items.length,
      selected_count: selectedCount,
      selected_units: selectedUnits,
      selected_investment: selectedInvestment,
      suggested_investment: suggestedInvestment
    }
  })

  return cards.sort((a, b) => {
    if (b.selected_investment !== a.selected_investment) {
      return b.selected_investment - a.selected_investment
    }
    return b.suggested_investment - a.suggested_investment
  })
})

const totalSelectedInvestment = computed(() =>
  categoryCards.value.reduce((sum, card) => sum + card.selected_investment, 0)
)

const generatedAtLabel = computed(() => {
  const raw = report.value?.scenario?.generated_at
  if (!raw) return ''
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('es-PE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
})

const activeCategory = computed(() =>
  categoryCards.value.find((card) => card.key === activeCategoryKey.value) || null
)

const modalRows = computed(() => {
  const card = activeCategory.value
  if (!card) return []

  const term = String(modalSearch.value || '').trim().toLowerCase()
  if (!term) return card.items

  return card.items.filter((item) => {
    const haystack = `${item.name} ${item.sku || ''} ${item.brand || ''}`.toLowerCase()
    return haystack.includes(term)
  })
})

const openCategoryModal = (key: string) => {
  activeCategoryKey.value = key
  modalSearch.value = ''
  categoryModalOpen.value = true
}

const closeCategoryModal = () => {
  categoryModalOpen.value = false
  activeCategoryKey.value = ''
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

watch(
  recommendations,
  (rows) => {
    rows.forEach((item) => {
      const key = String(item.product_id || '')
      if (!key || selectionByProduct[key]) return
      selectionByProduct[key] = {
        selected: false,
        qty: toInt(item.suggested_purchase_qty || 1, 1),
        unit: String(item.unit || 'unidad')
      }
    })
  },
  { immediate: true }
)

watch(categoryCards, (cards) => {
  if (!activeCategoryKey.value) return
  const exists = cards.some((card) => card.key === activeCategoryKey.value)
  if (!exists) closeCategoryModal()
})

const loadReport = async () => {
  loading.value = true
  error.value = ''

  try {
    report.value = await $fetch<RestockReport>('/api/reports/school-restock', {
      query: {
        min_required_units: scenario.min_required_units,
        limit: 5000
      }
    })
    message.value = 'Informe actualizado correctamente.'
  } catch (err: any) {
    error.value = err?.data?.statusMessage || err?.message || 'No se pudo generar el informe.'
  } finally {
    loading.value = false
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
    error.value = 'Selecciona al menos un producto para guardar la cotización.'
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
        min_required_units: scenario.min_required_units,
        notes: quoteNotes.value || null,
        items: selectedQuoteItems.value
      }
    })

    selectedQuoteItems.value.forEach((item) => {
      const selection = selectionByProduct[item.product_id]
      if (!selection) return
      selection.selected = false
    })
    quoteNotes.value = ''
    message.value = `Cotización guardada correctamente. Código: ${result.quote_id.slice(0, 8)}`
  } catch (err: any) {
    error.value = err?.data?.statusMessage || err?.message || 'No se pudo guardar la cotización.'
  } finally {
    savingQuote.value = false
  }
}

onMounted(async () => {
  await Promise.all([loadReport(), loadSuppliers()])
})
</script>

<template>
  <div class="space-y-6 pb-24 xl:pb-8">
    <section class="relative overflow-hidden rounded-2xl border border-indigo-100 bg-white p-6 shadow-sm">
      <div class="absolute -top-10 -right-16 h-40 w-40 rounded-full bg-indigo-100/70 blur-3xl" />
      <div class="relative z-10 flex flex-wrap items-start justify-between gap-4">
        <div class="max-w-3xl">
          <p class="text-xs font-extrabold uppercase tracking-[0.2em] text-indigo-500">Abastecimiento</p>
          <h2 class="mt-2 text-2xl font-extrabold text-slate-800">
            Informe de compra inmediata por stock
          </h2>
          <p class="mt-2 text-sm text-slate-500">
            Esta alerta sugiere compra cuando el stock actual esté por debajo del mínimo global definido.
          </p>
        </div>
        <NuxtLink to="/purchases" class="ui-btn-secondary">
          Ir a compras
        </NuxtLink>
      </div>
    </section>

    <section class="ui-card">
      <div class="flex flex-wrap gap-2">
        <button type="button" :class="tabClass('alerta')" @click="setTab('alerta')">
          Alerta inmediata
        </button>
        <button type="button" :class="tabClass('cotizaciones')" @click="setTab('cotizaciones')">
          Cotizaciones
        </button>
        <button type="button" :class="tabClass('sugeridos')" @click="setTab('sugeridos')">
          Sugeridos por ventas
        </button>
      </div>
      <p class="mt-3 text-xs font-medium text-slate-500">
        Todo el flujo ahora está dentro de esta vista (`/stock-ai`).
      </p>
    </section>

    <template v-if="activeTab === 'alerta'">
    <section class="ui-card">
      <div class="grid gap-3 md:max-w-sm">
        <label class="text-sm font-semibold text-slate-600">
          Mínimo requerido por producto (u.)
          <input
            v-model.number="scenario.min_required_units"
            type="number"
            min="1"
            max="5000"
            class="ui-input mt-1"
          />
        </label>
      </div>

      <div class="mt-4 flex flex-wrap items-center justify-between gap-3">
        <button class="ui-btn min-w-[190px]" :disabled="loading" @click="loadReport">
          {{ loading ? 'Calculando...' : 'Actualizar informe' }}
        </button>
      </div>

      <p class="mt-3 text-xs font-medium text-slate-500">
        Escenario actual:
        comprar cuando stock actual sea menor a {{ scenario.min_required_units }} unidades.
      </p>
    </section>

    <div v-if="error" class="ui-alert-error">{{ error }}</div>
    <div v-else-if="message" class="ui-alert">{{ message }}</div>

    <section v-if="report" class="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
      <article class="ui-card">
        <p class="text-xs font-semibold uppercase tracking-wide text-slate-400">Productos sugeridos</p>
        <p class="mt-2 text-3xl font-extrabold text-slate-800">{{ formatUnits(report.summary.suggested_products) }}</p>
        <p class="mt-1 text-xs text-slate-400">Stock menor al mínimo global</p>
      </article>

      <article class="ui-card">
        <p class="text-xs font-semibold uppercase tracking-wide text-slate-400">Críticos hoy</p>
        <p class="mt-2 text-3xl font-extrabold text-rose-600">{{ formatUnits(report.summary.critical_count) }}</p>
        <p class="mt-1 text-xs text-slate-400">Stockouts: {{ formatUnits(report.summary.stockouts_now) }}</p>
      </article>

      <article class="ui-card">
        <p class="text-xs font-semibold uppercase tracking-wide text-slate-400">Unidades por comprar</p>
        <p class="mt-2 text-3xl font-extrabold text-indigo-600">{{ formatUnits(report.summary.total_buy_units) }}</p>
        <p class="mt-1 text-xs text-slate-400">Para llegar al mínimo configurado</p>
      </article>

      <article class="ui-card">
        <p class="text-xs font-semibold uppercase tracking-wide text-slate-400">Inversión estimada</p>
        <p class="mt-2 text-2xl font-extrabold text-slate-800">{{ formatMoney(report.summary.estimated_investment) }}</p>
        <p class="mt-1 text-xs text-slate-400">Margen esperado: {{ formatMoney(report.summary.expected_margin) }}</p>
      </article>

      <article class="ui-card">
        <p class="text-xs font-semibold uppercase tracking-wide text-slate-400">Mínimo global</p>
        <p class="mt-2 text-3xl font-extrabold text-emerald-600">{{ formatUnits(report.scenario.min_required_units) }} u.</p>
        <p class="mt-1 text-xs text-slate-400">Actualizado: {{ generatedAtLabel || '-' }}</p>
      </article>
    </section>

    <section v-if="report" class="ui-card">
      <div class="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h3 class="text-lg font-extrabold text-slate-800">Listado por categorías</h3>
          <p class="text-sm text-slate-500">
            Haz clic en una categoría para elegir productos, cantidad y unidad en el modal.
          </p>
        </div>
        <div class="rounded-xl border border-indigo-100 bg-indigo-50 px-4 py-3">
          <p class="text-xs font-semibold uppercase tracking-wide text-indigo-600">Inversión total seleccionada</p>
          <p class="mt-1 text-xl font-extrabold text-indigo-700">{{ formatMoney(totalSelectedInvestment) }}</p>
        </div>
      </div>

      <div class="mt-4 grid gap-3 xl:grid-cols-[minmax(220px,1fr)_minmax(260px,1.5fr)_auto]">
        <label class="text-sm font-semibold text-slate-600">
          Proveedor cotización
          <select v-model="selectedSupplierId" class="ui-select mt-1 w-full">
            <option value="">Seleccionar proveedor</option>
            <option v-for="supplier in suppliers" :key="`supplier-${supplier.id}`" :value="supplier.id">
              {{ supplier.name }}
            </option>
          </select>
        </label>

        <label class="text-sm font-semibold text-slate-600">
          Nota cotización (opcional)
          <input
            v-model="quoteNotes"
            type="text"
            class="ui-input mt-1"
            placeholder="Ejemplo: campaña escolar marzo"
          />
        </label>

        <button
          class="ui-btn h-11 min-w-[220px] self-end"
          :disabled="savingQuote || !selectedSupplierId || !selectedQuoteItems.length"
          @click="saveSupplierQuote"
        >
          {{
            savingQuote
              ? 'Guardando cotización...'
              : `Guardar cotización (${formatUnits(selectedQuoteItems.length)} productos)`
          }}
        </button>
      </div>

      <p class="mt-2 text-xs font-medium text-slate-500">
        Seleccionados para cotizar:
        {{ formatUnits(selectedQuoteItems.length) }} productos ·
        {{ formatUnits(selectedQuoteUnits) }} unidades.
      </p>

      <div v-if="!categoryCards.length" class="ui-empty-state mt-5">
        No hay productos sugeridos para este escenario.
      </div>

      <div v-else class="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <button
          v-for="card in categoryCards"
          :key="`category-${card.key}`"
          type="button"
          class="rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-indigo-300 hover:shadow-md"
          @click="openCategoryModal(card.key)"
        >
          <p class="text-xs font-extrabold uppercase tracking-[0.16em] text-indigo-500">{{ card.label }}</p>
          <p class="mt-3 text-sm font-medium text-slate-500">
            {{ formatUnits(card.products_count) }} productos
          </p>
          <p class="text-sm font-medium text-slate-500">
            {{ formatUnits(card.selected_count) }} seleccionados · {{ formatUnits(card.selected_units) }} unidades
          </p>

          <div class="mt-4 rounded-xl border border-slate-100 bg-slate-50 px-3 py-2">
            <p class="text-xs text-slate-500">Costo total de inversión</p>
            <p class="mt-1 text-lg font-extrabold text-slate-800">{{ formatMoney(card.selected_investment) }}</p>
            <p class="mt-0.5 text-xs text-slate-400">
              Base sugerida: {{ formatMoney(card.suggested_investment) }}
            </p>
          </div>
        </button>
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
      <div v-if="categoryModalOpen" class="fixed inset-0 z-[80]">
        <button
          class="absolute inset-0 bg-slate-900/55"
          aria-label="Cerrar modal"
          @click="closeCategoryModal"
        />

        <div class="absolute inset-0 overflow-y-auto p-4 sm:p-6" @click.stop>
          <article
            v-if="activeCategory"
            class="mx-auto my-2 flex max-h-[calc(100dvh-1rem)] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl sm:my-4 sm:max-h-[calc(100dvh-3rem)]"
          >
            <header class="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 px-5 py-4 sm:px-6">
              <div>
                <p class="text-xs font-extrabold uppercase tracking-[0.16em] text-indigo-500">Categoría</p>
                <h3 class="mt-1 text-xl font-extrabold text-slate-800">{{ activeCategory.label }}</h3>
                <p class="mt-1 text-sm text-slate-500">
                  Selecciona productos y define cantidad/unidad para calcular inversión.
                </p>
              </div>
              <button class="ui-btn-secondary" @click="closeCategoryModal">Cerrar</button>
            </header>

            <div class="min-h-0 space-y-4 overflow-y-auto p-5 sm:p-6">
              <div class="grid gap-3 sm:grid-cols-3">
                <div class="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2">
                  <p class="text-xs text-slate-500">Productos categoría</p>
                  <p class="mt-1 text-lg font-bold text-slate-800">{{ formatUnits(activeCategory.products_count) }}</p>
                </div>
                <div class="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2">
                  <p class="text-xs text-slate-500">Seleccionados</p>
                  <p class="mt-1 text-lg font-bold text-slate-800">{{ formatUnits(activeCategory.selected_count) }}</p>
                </div>
                <div class="rounded-xl border border-indigo-100 bg-indigo-50 px-3 py-2">
                  <p class="text-xs text-indigo-600">Costo total de inversión</p>
                  <p class="mt-1 text-lg font-bold text-indigo-700">{{ formatMoney(activeCategory.selected_investment) }}</p>
                </div>
              </div>

              <input
                v-model="modalSearch"
                type="text"
                class="ui-input"
                placeholder="Buscar por nombre, código o marca..."
              />

              <div class="ui-table-wrap max-h-[56vh] overflow-auto">
                <table class="ui-table">
                  <thead>
                    <tr>
                      <th>Check selected</th>
                      <th>Name</th>
                      <th>codigo</th>
                      <th>costo_compra</th>
                      <th>Cantidad</th>
                      <th>Unidad</th>
                      <th>Inversión</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="item in modalRows"
                      :key="`modal-${item.product_id}`"
                      :class="ensureSelection(item).selected ? 'bg-indigo-50/50' : ''"
                    >
                      <td>
                        <input
                          v-model="ensureSelection(item).selected"
                          type="checkbox"
                          class="h-4 w-4 rounded border-slate-300"
                        />
                      </td>
                      <td>
                        <p class="font-semibold text-slate-800">{{ item.name }}</p>
                        <p class="mt-1 text-xs text-slate-400">{{ item.brand || 'Sin marca' }}</p>
                      </td>
                      <td class="font-semibold text-slate-700">{{ item.sku || '-' }}</td>
                      <td class="font-semibold text-slate-700">{{ formatMoney(item.estimated_unit_cost) }}</td>
                      <td>
                        <input
                          v-model.number="ensureSelection(item).qty"
                          type="number"
                          min="1"
                          step="1"
                          class="ui-input max-w-[120px]"
                          :disabled="!ensureSelection(item).selected"
                          @input="sanitizeQty(item)"
                          @change="sanitizeQty(item)"
                        />
                      </td>
                      <td>
                        <select
                          v-model="ensureSelection(item).unit"
                          class="ui-select min-w-[130px]"
                          :disabled="!ensureSelection(item).selected"
                        >
                          <option v-for="option in unitOptions(item)" :key="`${item.product_id}-${option}`" :value="option">
                            {{ option }}
                          </option>
                        </select>
                      </td>
                      <td class="font-semibold text-slate-800">{{ formatMoney(lineInvestment(item)) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </article>
        </div>
      </div>
    </transition>
    </template>
    <StockAiQuotesView v-else-if="activeTab === 'cotizaciones'" />
    <StockAiSalesSuggestedView v-else />
  </div>
</template>
