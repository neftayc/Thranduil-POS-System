<script setup lang="ts">
definePageMeta({ middleware: ['owner'] })

type ExecutiveProfitabilityPeriodCode =
  | 'recovery_2025_to_2026_03_08'
  | 'standard_from_2026_03_09'

type ExecutiveProfitabilityPeriodFilter = 'auto' | ExecutiveProfitabilityPeriodCode

type ExecutiveProfitabilityBucketGranularity = 'weekly' | 'monthly' | 'yearly' | 'total'

type ExecutiveProfitabilityBucket = {
  granularity: ExecutiveProfitabilityBucketGranularity
  key: string
  label: string
  start_date: string
  end_date: string | null
  purchase_items_count: number
  sale_items_count: number
  adjustment_items_count: number
  purchases_total: number
  sales_recorded_total: number
  sales_from_adjustment_total: number
  sales_total: number
  sales_cogs_total: number
  adjustments_cogs_total: number
  gross_profit_total: number
  balance_total: number
  margin_pct: number
  profit_ten_percent: number
  net_after_profit_share: number
}

type ExecutiveProfitabilityReport = {
  generated_at: string
  period_code: ExecutiveProfitabilityPeriodCode
  period_start: string
  period_end: string | null
  adjustments_counted_as_sales: boolean
  totals: ExecutiveProfitabilityBucket
  weekly: ExecutiveProfitabilityBucket[]
  monthly: ExecutiveProfitabilityBucket[]
  yearly: ExecutiveProfitabilityBucket[]
}

const loading = ref(false)
const errorMessage = ref('')
const selectedPeriod = ref<ExecutiveProfitabilityPeriodFilter>('auto')
const generatedAt = ref<string | null>(null)
const reportPeriodCode = ref<ExecutiveProfitabilityPeriodCode | null>(null)
const reportPeriodStart = ref<string | null>(null)
const reportPeriodEnd = ref<string | null>(null)
const adjustmentsCountedAsSales = ref(false)

const emptyBucket = (): ExecutiveProfitabilityBucket => ({
  granularity: 'total',
  key: 'total',
  label: 'Total',
  start_date: '',
  end_date: null,
  purchase_items_count: 0,
  sale_items_count: 0,
  adjustment_items_count: 0,
  purchases_total: 0,
  sales_recorded_total: 0,
  sales_from_adjustment_total: 0,
  sales_total: 0,
  sales_cogs_total: 0,
  adjustments_cogs_total: 0,
  gross_profit_total: 0,
  balance_total: 0,
  margin_pct: 0,
  profit_ten_percent: 0,
  net_after_profit_share: 0
})

const report = reactive<ExecutiveProfitabilityReport>({
  generated_at: '',
  period_code: 'standard_from_2026_03_09',
  period_start: '',
  period_end: null,
  adjustments_counted_as_sales: false,
  totals: emptyBucket(),
  weekly: [],
  monthly: [],
  yearly: []
})

const moneyFormatter = new Intl.NumberFormat('es-PE', {
  style: 'currency',
  currency: 'PEN',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
})

const countFormatter = new Intl.NumberFormat('es-PE', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0
})

const percentFormatter = new Intl.NumberFormat('es-PE', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2
})

const formatMoney = (value: number) => moneyFormatter.format(Number(value || 0))
const formatCount = (value: number) => countFormatter.format(Number(value || 0))
const formatPercent = (value: number) => `${percentFormatter.format(Number(value || 0))}%`

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

const periodCodeLabel = computed(() => {
  if (reportPeriodCode.value === 'recovery_2025_to_2026_03_08') return 'Recuperacion 2025-2026'
  if (reportPeriodCode.value === 'standard_from_2026_03_09') return 'Operacion normal'
  return ''
})

const periodModeLabel = computed(() =>
  adjustmentsCountedAsSales.value
    ? 'Modo recuperacion: los ajustes negativos tambien entran como ventas estimadas.'
    : 'Modo normal: las ventas solo consideran ventas registradas.'
)

const totalCost = (bucket: ExecutiveProfitabilityBucket) =>
  Number(bucket.sales_cogs_total || 0) + Number(bucket.adjustments_cogs_total || 0)

const weeklyTrendSeries = computed(() => [
  {
    key: 'sales',
    label: 'Ventas',
    color: '#4338ca',
    values: report.weekly.map((bucket) => bucket.sales_total)
  },
  {
    key: 'cost',
    label: 'Costo',
    color: '#ef4444',
    values: report.weekly.map((bucket) => totalCost(bucket))
  },
  {
    key: 'profit',
    label: 'Ganancia',
    color: '#10b981',
    values: report.weekly.map((bucket) => bucket.gross_profit_total)
  }
])

const monthlyTrendSeries = computed(() => [
  {
    key: 'sales',
    label: 'Ventas',
    color: '#4338ca',
    values: report.monthly.map((bucket) => bucket.sales_total)
  },
  {
    key: 'cost',
    label: 'Costo',
    color: '#ef4444',
    values: report.monthly.map((bucket) => totalCost(bucket))
  },
  {
    key: 'profit',
    label: 'Ganancia',
    color: '#10b981',
    values: report.monthly.map((bucket) => bucket.gross_profit_total)
  }
])

const yearlyTrendSeries = computed(() => [
  {
    key: 'sales',
    label: 'Ventas',
    color: '#4338ca',
    values: report.yearly.map((bucket) => bucket.sales_total)
  },
  {
    key: 'cost',
    label: 'Costo',
    color: '#ef4444',
    values: report.yearly.map((bucket) => totalCost(bucket))
  },
  {
    key: 'profit',
    label: 'Ganancia',
    color: '#10b981',
    values: report.yearly.map((bucket) => bucket.gross_profit_total)
  }
])

const loadReport = async () => {
  loading.value = true
  errorMessage.value = ''

  try {
    const data = await $fetch<ExecutiveProfitabilityReport>('/api/reports/executive-profitability', {
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

    report.generated_at = data.generated_at || ''
    report.period_code = data.period_code
    report.period_start = data.period_start
    report.period_end = data.period_end
    report.adjustments_counted_as_sales = data.adjustments_counted_as_sales === true
    report.totals = data.totals || emptyBucket()
    report.weekly = data.weekly || []
    report.monthly = data.monthly || []
    report.yearly = data.yearly || []
  } catch (err: any) {
    errorMessage.value = err?.data?.statusMessage || err?.message || 'No se pudo cargar el reporte ejecutivo.'
  } finally {
    loading.value = false
  }
}

onMounted(loadReport)
</script>

<template>
  <div class="space-y-8">
    <section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div class="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 class="text-xl font-bold text-slate-800">Reporte ejecutivo de rentabilidad</h2>
          <p class="mt-1 text-sm text-slate-500">
            Vista de dirección para leer rentabilidad por semana, mes, ano y total con los mismos cortes contables del negocio.
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
              @change="loadReport"
            >
              <option value="auto">Periodo actual (automatico)</option>
              <option value="recovery_2025_to_2026_03_08">Recuperacion: 01/01/2025 - 08/03/2026</option>
              <option value="standard_from_2026_03_09">Normal: desde 09/03/2026</option>
            </select>
          </label>

          <button
            class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
            type="button"
            :disabled="loading"
            @click="loadReport"
          >
            {{ loading ? 'Actualizando...' : 'Actualizar reporte' }}
          </button>
        </div>
      </div>

      <p
        v-if="errorMessage"
        class="mt-4 rounded-lg border px-3 py-2 text-sm font-medium border-rose-200 bg-rose-50 text-rose-600"
      >
        {{ errorMessage }}
      </p>
    </section>

    <section class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      <article class="card-hover rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <p class="text-xs font-bold uppercase tracking-wide text-slate-400">Ventas totales</p>
        <p class="mt-2 text-3xl font-bold text-slate-800">{{ loading ? '...' : formatMoney(report.totals.sales_total) }}</p>
        <p class="mt-1 text-xs font-medium text-slate-500">
          Registradas: {{ loading ? '...' : formatMoney(report.totals.sales_recorded_total) }} · Ajustes: {{ loading ? '...' : formatMoney(report.totals.sales_from_adjustment_total) }}
        </p>
      </article>

      <article class="card-hover rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <p class="text-xs font-bold uppercase tracking-wide text-slate-400">Costo total</p>
        <p class="mt-2 text-3xl font-bold text-rose-600">{{ loading ? '...' : formatMoney(totalCost(report.totals)) }}</p>
        <p class="mt-1 text-xs font-medium text-slate-500">
          Compras: {{ loading ? '...' : formatMoney(report.totals.purchases_total) }}
        </p>
      </article>

      <article class="card-hover rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <p class="text-xs font-bold uppercase tracking-wide text-slate-400">Ganancia bruta</p>
        <p class="mt-2 text-3xl font-bold" :class="report.totals.gross_profit_total >= 0 ? 'text-emerald-600' : 'text-rose-600'">
          {{ loading ? '...' : formatMoney(report.totals.gross_profit_total) }}
        </p>
        <p class="mt-1 text-xs font-medium text-slate-500">
          Margen: {{ loading ? '...' : formatPercent(report.totals.margin_pct) }}
        </p>
      </article>

      <article class="card-hover rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <p class="text-xs font-bold uppercase tracking-wide text-slate-400">Balance</p>
        <p class="mt-2 text-3xl font-bold" :class="report.totals.balance_total >= 0 ? 'text-emerald-600' : 'text-rose-600'">
          {{ loading ? '...' : formatMoney(report.totals.balance_total) }}
        </p>
        <p class="mt-1 text-xs font-medium text-slate-500">
          Ventas - compras
        </p>
      </article>

      <article class="card-hover rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <p class="text-xs font-bold uppercase tracking-wide text-slate-400">10% de ganancia</p>
        <p class="mt-2 text-3xl font-bold text-indigo-600">{{ loading ? '...' : formatMoney(report.totals.profit_ten_percent) }}</p>
        <p class="mt-1 text-xs font-medium text-slate-500">
          Neto despues del 10%: {{ loading ? '...' : formatMoney(report.totals.net_after_profit_share) }}
        </p>
      </article>

      <article class="card-hover rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <p class="text-xs font-bold uppercase tracking-wide text-slate-400">Movimientos visibles</p>
        <p class="mt-2 text-3xl font-bold text-slate-800">{{ loading ? '...' : formatCount(report.totals.sale_items_count + report.totals.purchase_items_count + report.totals.adjustment_items_count) }}</p>
        <p class="mt-1 text-xs font-medium text-slate-500">
          Compras: {{ loading ? '...' : formatCount(report.totals.purchase_items_count) }} · Ventas: {{ loading ? '...' : formatCount(report.totals.sale_items_count) }}
        </p>
      </article>
    </section>

    <ExecutiveCompositionBar
      :sales-total="report.totals.sales_total"
      :cogs-total="totalCost(report.totals)"
      :gross-profit-total="report.totals.gross_profit_total"
      :margin-pct="report.totals.margin_pct"
      :profit-ten-percent="report.totals.profit_ten_percent"
      :net-after-profit-share="report.totals.net_after_profit_share"
      :format-money="formatMoney"
      :format-percent="formatPercent"
    />

    <ExecutiveTrendChart
      title="Tendencia semanal"
      subtitle="Domingo a sabado. Permite detectar picos, caidas y semanas de baja utilidad."
      :labels="report.weekly.map((bucket) => bucket.label)"
      :series="weeklyTrendSeries"
      :format-value="formatMoney"
      empty-state="No hay semanas disponibles para el periodo seleccionado."
    />

    <section class="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div class="flex flex-col gap-1 border-b border-slate-100 p-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h3 class="text-lg font-bold text-slate-800">Detalle semanal</h3>
          <p class="text-sm font-medium text-slate-500">Semana calendario de domingo a sabado.</p>
        </div>
        <p class="text-xs font-semibold text-slate-500">
          {{ formatCount(report.weekly.length) }} semanas
        </p>
      </div>
      <div class="overflow-x-auto">
        <table class="min-w-full divide-y divide-slate-200 text-sm">
          <thead class="bg-slate-50">
            <tr>
              <th class="px-4 py-3 text-left font-bold text-slate-600">Semana</th>
              <th class="px-4 py-3 text-right font-bold text-slate-600">Ventas</th>
              <th class="px-4 py-3 text-right font-bold text-slate-600">Costo</th>
              <th class="px-4 py-3 text-right font-bold text-slate-600">Ganancia</th>
              <th class="px-4 py-3 text-right font-bold text-slate-600">Margen</th>
              <th class="px-4 py-3 text-right font-bold text-slate-600">Balance</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            <tr v-if="!report.weekly.length">
              <td colspan="6" class="px-4 py-6 text-center text-sm font-medium text-slate-400">
                No hay datos semanales para el periodo seleccionado.
              </td>
            </tr>
            <tr v-for="bucket in report.weekly" :key="bucket.key">
              <td class="px-4 py-3 font-semibold text-slate-700">{{ bucket.label }}</td>
              <td class="px-4 py-3 text-right font-medium text-slate-700">{{ formatMoney(bucket.sales_total) }}</td>
              <td class="px-4 py-3 text-right font-medium text-rose-600">{{ formatMoney(totalCost(bucket)) }}</td>
              <td class="px-4 py-3 text-right font-semibold" :class="bucket.gross_profit_total >= 0 ? 'text-emerald-600' : 'text-rose-600'">
                {{ formatMoney(bucket.gross_profit_total) }}
              </td>
              <td class="px-4 py-3 text-right font-medium text-slate-700">{{ formatPercent(bucket.margin_pct) }}</td>
              <td class="px-4 py-3 text-right font-medium text-slate-700">{{ formatMoney(bucket.balance_total) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <ExecutiveTrendChart
      title="Tendencia mensual"
      subtitle="La mejor vista para dirección cuando se quieren comparar cierres de mes."
      :labels="report.monthly.map((bucket) => bucket.label)"
      :series="monthlyTrendSeries"
      :format-value="formatMoney"
      empty-state="No hay meses disponibles para el periodo seleccionado."
    />

    <section class="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div class="flex flex-col gap-1 border-b border-slate-100 p-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h3 class="text-lg font-bold text-slate-800">Detalle mensual</h3>
          <p class="text-sm font-medium text-slate-500">Consolidado por mes calendario.</p>
        </div>
        <p class="text-xs font-semibold text-slate-500">
          {{ formatCount(report.monthly.length) }} meses
        </p>
      </div>
      <div class="overflow-x-auto">
        <table class="min-w-full divide-y divide-slate-200 text-sm">
          <thead class="bg-slate-50">
            <tr>
              <th class="px-4 py-3 text-left font-bold text-slate-600">Mes</th>
              <th class="px-4 py-3 text-right font-bold text-slate-600">Ventas</th>
              <th class="px-4 py-3 text-right font-bold text-slate-600">Costo</th>
              <th class="px-4 py-3 text-right font-bold text-slate-600">Ganancia</th>
              <th class="px-4 py-3 text-right font-bold text-slate-600">Margen</th>
              <th class="px-4 py-3 text-right font-bold text-slate-600">Balance</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            <tr v-if="!report.monthly.length">
              <td colspan="6" class="px-4 py-6 text-center text-sm font-medium text-slate-400">
                No hay datos mensuales para el periodo seleccionado.
              </td>
            </tr>
            <tr v-for="bucket in report.monthly" :key="bucket.key">
              <td class="px-4 py-3 font-semibold text-slate-700">{{ bucket.label }}</td>
              <td class="px-4 py-3 text-right font-medium text-slate-700">{{ formatMoney(bucket.sales_total) }}</td>
              <td class="px-4 py-3 text-right font-medium text-rose-600">{{ formatMoney(totalCost(bucket)) }}</td>
              <td class="px-4 py-3 text-right font-semibold" :class="bucket.gross_profit_total >= 0 ? 'text-emerald-600' : 'text-rose-600'">
                {{ formatMoney(bucket.gross_profit_total) }}
              </td>
              <td class="px-4 py-3 text-right font-medium text-slate-700">{{ formatPercent(bucket.margin_pct) }}</td>
              <td class="px-4 py-3 text-right font-medium text-slate-700">{{ formatMoney(bucket.balance_total) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <ExecutiveTrendChart
      title="Tendencia anual"
      subtitle="Vista de largo plazo para evaluar crecimiento y rentabilidad del negocio."
      :labels="report.yearly.map((bucket) => bucket.label)"
      :series="yearlyTrendSeries"
      :format-value="formatMoney"
      empty-state="No hay datos anuales para el periodo seleccionado."
    />

    <section class="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div class="flex flex-col gap-1 border-b border-slate-100 p-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h3 class="text-lg font-bold text-slate-800">Detalle anual</h3>
          <p class="text-sm font-medium text-slate-500">Consolidado por ano calendario.</p>
        </div>
        <p class="text-xs font-semibold text-slate-500">
          {{ formatCount(report.yearly.length) }} anos
        </p>
      </div>
      <div class="overflow-x-auto">
        <table class="min-w-full divide-y divide-slate-200 text-sm">
          <thead class="bg-slate-50">
            <tr>
              <th class="px-4 py-3 text-left font-bold text-slate-600">Ano</th>
              <th class="px-4 py-3 text-right font-bold text-slate-600">Ventas</th>
              <th class="px-4 py-3 text-right font-bold text-slate-600">Costo</th>
              <th class="px-4 py-3 text-right font-bold text-slate-600">Ganancia</th>
              <th class="px-4 py-3 text-right font-bold text-slate-600">Margen</th>
              <th class="px-4 py-3 text-right font-bold text-slate-600">Balance</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            <tr v-if="!report.yearly.length">
              <td colspan="6" class="px-4 py-6 text-center text-sm font-medium text-slate-400">
                No hay datos anuales para el periodo seleccionado.
              </td>
            </tr>
            <tr v-for="bucket in report.yearly" :key="bucket.key">
              <td class="px-4 py-3 font-semibold text-slate-700">{{ bucket.label }}</td>
              <td class="px-4 py-3 text-right font-medium text-slate-700">{{ formatMoney(bucket.sales_total) }}</td>
              <td class="px-4 py-3 text-right font-medium text-rose-600">{{ formatMoney(totalCost(bucket)) }}</td>
              <td class="px-4 py-3 text-right font-semibold" :class="bucket.gross_profit_total >= 0 ? 'text-emerald-600' : 'text-rose-600'">
                {{ formatMoney(bucket.gross_profit_total) }}
              </td>
              <td class="px-4 py-3 text-right font-medium text-slate-700">{{ formatPercent(bucket.margin_pct) }}</td>
              <td class="px-4 py-3 text-right font-medium text-slate-700">{{ formatMoney(bucket.balance_total) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
