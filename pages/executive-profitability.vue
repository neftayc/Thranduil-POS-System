<script setup lang="ts">
definePageMeta({ middleware: ['owner'] })

useHead({
  title: 'Reporte ejecutivo de rentabilidad'
})

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

type ProductProfitabilityItem = {
  product_id: string
  name: string
  category_name: string | null
  stock_on_hand: number
  sales_total: number
  sales_qty?: number
  purchase_total: number
  margin_pct: number | null
  inventory_value: number
  last_sale_at: string | null
  status: string
}

type ProductProfitabilityReport = {
  items: ProductProfitabilityItem[]
}

type ExecutiveFocus = 'overview' | 'weekly' | 'monthly' | 'yearly' | 'total'

type TrendSeries = {
  key: string
  label: string
  color: string
  values: number[]
}

type BucketSummary = {
  count: number
  positiveCount: number
  negativeCount: number
  averageMargin: number
  bestProfit: ExecutiveProfitabilityBucket | null
  worstProfit: ExecutiveProfitabilityBucket | null
  bestMargin: ExecutiveProfitabilityBucket | null
  highestSales: ExecutiveProfitabilityBucket | null
}

type ExecutiveDecisionTone = 'critical' | 'warning' | 'good' | 'neutral'

type ExecutiveSignal = {
  key: string
  label: string
  value: string
  helper: string
  tone: ExecutiveDecisionTone
  progress: number
}

type ExecutiveScenario = {
  key: string
  label: string
  value: string
  helper: string
  tone: ExecutiveDecisionTone
}

type ProfitBridgeItem = {
  key: string
  label: string
  value: number
  displayValue: string
  helper: string
  tone: ExecutiveDecisionTone
  width: number
}

type WeeklyDecisionPoint = {
  key: string
  label: string
  value: number
  displayValue: string
  sales: string
  margin: string
  tone: ExecutiveDecisionTone
  width: number
}

type ExecutiveKpiCard = {
  key: string
  title: string
  value: string
  icon: string
  iconBg: string
  helper: string
  trendClass: string
}

type SimpleBarDatum = {
  key: string
  label: string
  value: number
  displayValue: string
  color: string
  width: number
}

type CategoryMetric = SimpleBarDatum & {
  status: string
}

type ExecutiveScoreRule = {
  label: string
  value: string
  tone: 'plus' | 'minus'
}

type ExecutiveApiChartItem = {
  key?: string
  label: string
  value: number
  displayValue?: string
  color: string
  status?: string
}

type ExecutiveApiReport = {
  generated_at: string
  period_code: ExecutiveProfitabilityPeriodCode
  period_start: string
  period_end: string
  period_label: string
  mode_label: string
  adjustments_counted_as_sales: boolean
  decision: {
    tone: ExecutiveDecisionTone
    label: string
    title: string
    copy: string
    icon: string
    score: number
    score_text: string
  }
  conclusion: string
  score_rules: ExecutiveScoreRule[]
  kpis: ExecutiveKpiCard[]
  charts: {
    sales: { title: string; subtitle: string; insight: string; labels: string[]; ventas: number[]; unidades: number[] }
    waterfall: { title: string; subtitle: string; insight: string; items: ExecutiveApiChartItem[] }
    recovery: { title: string; subtitle: string; insight: string; items: ExecutiveApiChartItem[] }
    cash: { title: string; subtitle: string; insight: string; items: ExecutiveApiChartItem[] }
    gmroi: { title: string; subtitle: string; insight: string; items: ExecutiveApiChartItem[] }
    profit: { title: string; subtitle: string; insight: string; items: ExecutiveApiChartItem[] }
    inventory: { title: string; subtitle: string; insight: string; items: ExecutiveApiChartItem[]; centerValue: string; centerLabel: string }
    aging: { title: string; subtitle: string; insight: string; items: ExecutiveApiChartItem[] }
  }
  risk_items: Array<{ key: string; label: string; value: string; tone: string; icon: string }>
  goal: { percent: number; percentLabel: string; items: Array<{ label: string; value: string; tone: string }> }
  scenarios: Array<{ key: string; title: string; value: string; copy: string; tag: string; recommended: boolean }>
  actions: Array<{ key: string; title: string; copy: string; tone: ExecutiveDecisionTone }>
  scenario_cards: ExecutiveScenario[]
  totals: ExecutiveProfitabilityBucket
  weekly: ExecutiveProfitabilityBucket[]
  monthly: ExecutiveProfitabilityBucket[]
  yearly: ExecutiveProfitabilityBucket[]
  product_items: ProductProfitabilityItem[]
}

const todayDateKey = () => {
  const date = new Date()
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const loading = ref(false)
const errorMessage = ref('')
const selectedPeriod = ref<ExecutiveProfitabilityPeriodFilter>('auto')
const selectedFocus = ref<ExecutiveFocus>('overview')
const generatedAt = ref<string | null>(null)
const reportPeriodCode = ref<ExecutiveProfitabilityPeriodCode | null>(null)
const reportPeriodStart = ref<string | null>(null)
const reportPeriodEnd = ref<string | null>(null)
const adjustmentsCountedAsSales = ref(false)
const productItems = ref<ProductProfitabilityItem[]>([])
const executiveApiReport = ref<ExecutiveApiReport | null>(null)
const selectedStartDate = ref('2026-03-09')
const selectedEndDate = ref(todayDateKey())
const selectedSalesMode = ref<'ventas' | 'unidades'>('ventas')

const salesChartCanvas = ref<HTMLCanvasElement | null>(null)
const waterfallChartCanvas = ref<HTMLCanvasElement | null>(null)
const recoveryChartCanvas = ref<HTMLCanvasElement | null>(null)
const cashChartCanvas = ref<HTMLCanvasElement | null>(null)
const gmroiChartCanvas = ref<HTMLCanvasElement | null>(null)
const inventoryChartCanvas = ref<HTMLCanvasElement | null>(null)
const agingChartCanvas = ref<HTMLCanvasElement | null>(null)

let redrawTimer: ReturnType<typeof setTimeout> | null = null

const report = reactive<ExecutiveProfitabilityReport>({
  generated_at: '',
  period_code: 'standard_from_2026_03_09',
  period_start: '',
  period_end: null,
  adjustments_counted_as_sales: false,
  totals: {
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
  },
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

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

const chartItemsWithWidth = (items: ExecutiveApiChartItem[]): SimpleBarDatum[] => {
  const max = Math.max(...items.map((item) => Math.abs(Number(item.value || 0))), 1)
  return items.map((item) => ({
    key: item.key || item.label,
    label: item.label,
    value: Number(item.value || 0),
    displayValue: item.displayValue || formatMoney(Number(item.value || 0)),
    color: item.color,
    width: clamp((Math.abs(Number(item.value || 0)) / max) * 100, 4, 100)
  }))
}

const categoryItemsWithWidth = (items: ExecutiveApiChartItem[]): CategoryMetric[] => {
  const max = Math.max(...items.map((item) => Math.abs(Number(item.value || 0))), 1)
  return items.map((item) => ({
    key: item.key || item.label,
    label: item.label,
    value: Number(item.value || 0),
    displayValue: item.displayValue || String(item.value),
    color: item.color,
    width: clamp((Math.abs(Number(item.value || 0)) / max) * 100, 4, 100),
    status: item.status || ''
  }))
}

const totalCost = (bucket: ExecutiveProfitabilityBucket) =>
  Number(bucket.sales_cogs_total || 0) + Number(bucket.adjustments_cogs_total || 0)

const toDateKey = (value: string | null) => {
  if (!value) return ''
  return value.slice(0, 10)
}

const daysBetween = (start: string | null, end: string | null) => {
  const startKey = toDateKey(start)
  const endKey = toDateKey(end)
  if (!startKey || !endKey) return null
  const startDate = new Date(`${startKey}T00:00:00`)
  const endDate = new Date(`${endKey}T00:00:00`)
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return null
  return Math.max(0, Math.round((endDate.getTime() - startDate.getTime()) / 86400000))
}

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
  if (reportPeriodCode.value === 'recovery_2025_to_2026_03_08') return 'Recuperación 2025-2026'
  if (reportPeriodCode.value === 'standard_from_2026_03_09') return 'Operación normal'
  return ''
})

const periodModeLabel = computed(() =>
  adjustmentsCountedAsSales.value
    ? 'Modo recuperación: las ventas incluyen ventas registradas y ajustes negativos de inventario.'
    : 'Modo normal: las ventas incluyen solo ventas registradas.'
)

const focusOptions: Array<{
  key: ExecutiveFocus
  label: string
  description: string
  targetId: string
}> = [
  { key: 'overview', label: 'Resumen', description: 'Panorama ejecutivo', targetId: 'overview-focus' },
  { key: 'weekly', label: 'Semanal', description: 'Domingo a sábado', targetId: 'weekly-section' },
  { key: 'monthly', label: 'Mensual', description: 'Comparación por cierre', targetId: 'monthly-section' },
  { key: 'yearly', label: 'Anual', description: 'Lectura de largo plazo', targetId: 'yearly-section' },
  { key: 'total', label: 'Total', description: 'Composición general', targetId: 'total-section' }
]

const focusTargetByKey: Record<ExecutiveFocus, string> = {
  overview: 'overview-focus',
  weekly: 'weekly-section',
  monthly: 'monthly-section',
  yearly: 'yearly-section',
  total: 'total-section'
}

const selectedFocusLabel = computed(() => {
  if (selectedFocus.value === 'overview') return 'Resumen de dirección'
  if (selectedFocus.value === 'weekly') return 'Lectura semanal'
  if (selectedFocus.value === 'monthly') return 'Lectura mensual'
  if (selectedFocus.value === 'yearly') return 'Lectura anual'
  return 'Composición total'
})

const selectedFocusDescription = computed(() => {
  if (selectedFocus.value === 'overview') {
    return 'La vista inicial prioriza la semana para detectar cambios de rentabilidad con rapidez.'
  }
  if (selectedFocus.value === 'weekly') {
    return 'Semana calendario de domingo a sábado para leer picos, caídas y semanas con utilidad negativa.'
  }
  if (selectedFocus.value === 'monthly') {
    return 'Comparación mensual para dirección, útil para revisar cierres y estacionalidad.'
  }
  if (selectedFocus.value === 'yearly') {
    return 'Lectura anual para validar crecimiento, consistencia y resistencia del negocio.'
  }
  return 'Vista consolidada para entender ventas, costo, utilidad bruta, balance y participación del 10%.'
})

const buildSeries = (buckets: ExecutiveProfitabilityBucket[]): TrendSeries[] => [
  {
    key: 'sales',
    label: 'Ventas',
    color: '#4338ca',
    values: buckets.map((bucket) => bucket.sales_total)
  },
  {
    key: 'cost',
    label: 'Costo',
    color: '#ef4444',
    values: buckets.map((bucket) => totalCost(bucket))
  },
  {
    key: 'profit',
    label: 'Ganancia',
    color: '#10b981',
    values: buckets.map((bucket) => bucket.gross_profit_total)
  }
]

const summarizeBuckets = (buckets: ExecutiveProfitabilityBucket[]): BucketSummary => {
  const positiveCount = buckets.filter((bucket) => bucket.gross_profit_total >= 0).length
  const negativeCount = buckets.filter((bucket) => bucket.gross_profit_total < 0).length
  let bestProfit: ExecutiveProfitabilityBucket | null = null
  let worstProfit: ExecutiveProfitabilityBucket | null = null
  let bestMargin: ExecutiveProfitabilityBucket | null = null
  let highestSales: ExecutiveProfitabilityBucket | null = null
  let salesTotal = 0
  let profitTotal = 0

  for (const bucket of buckets) {
    salesTotal += Number(bucket.sales_total || 0)
    profitTotal += Number(bucket.gross_profit_total || 0)

    if (!bestProfit || bucket.gross_profit_total > bestProfit.gross_profit_total) {
      bestProfit = bucket
    }

    if (!worstProfit || bucket.gross_profit_total < worstProfit.gross_profit_total) {
      worstProfit = bucket
    }

    if (bucket.sales_total > 0 && (!bestMargin || bucket.margin_pct > bestMargin.margin_pct)) {
      bestMargin = bucket
    }

    if (!highestSales || bucket.sales_total > highestSales.sales_total) {
      highestSales = bucket
    }
  }

  return {
    count: buckets.length,
    positiveCount,
    negativeCount,
    averageMargin: salesTotal > 0 ? (profitTotal / salesTotal) * 100 : 0,
    bestProfit,
    worstProfit,
    bestMargin,
    highestSales
  }
}

const weeklySeries = computed(() => buildSeries(report.weekly))
const monthlySeries = computed(() => buildSeries(report.monthly))
const yearlySeries = computed(() => buildSeries(report.yearly))

const focusBuckets = computed(() => {
  if (selectedFocus.value === 'monthly') return report.monthly
  if (selectedFocus.value === 'yearly') return report.yearly
  if (selectedFocus.value === 'total') return [report.totals]
  return report.weekly
})

const focusBucketsSummary = computed(() => summarizeBuckets(focusBuckets.value))

const focusChartTitle = computed(() => {
  if (selectedFocus.value === 'monthly') return 'Comparación mensual'
  if (selectedFocus.value === 'yearly') return 'Comparación anual'
  if (selectedFocus.value === 'total') return 'Composición del total'
  if (selectedFocus.value === 'weekly') return 'Tendencia semanal'
  return 'Panorama semanal de dirección'
})

const focusChartSubtitle = computed(() => {
  if (selectedFocus.value === 'monthly') return 'Útil para revisar cierres, estacionalidad y variaciones entre meses.'
  if (selectedFocus.value === 'yearly') return 'Vista de largo plazo para validar consistencia y crecimiento.'
  if (selectedFocus.value === 'total') return 'Relación entre ventas, costo, ganancia bruta, margen y neto del 10%.'
  return 'Semana calendario de domingo a sábado para detectar cambios rápidos en utilidad y costo.'
})

const focusChartLabels = computed(() => focusBuckets.value.map((bucket) => bucket.label))
const focusChartSeries = computed(() => buildSeries(focusBuckets.value))

const allPeriodSummary = computed(() => summarizeBuckets(report.weekly))

const nonEmptyWeeklyBuckets = computed(() =>
  report.weekly.filter((bucket) =>
    Math.abs(Number(bucket.sales_total || 0)) > 0 ||
    Math.abs(totalCost(bucket)) > 0 ||
    Math.abs(Number(bucket.purchases_total || 0)) > 0
  )
)

const latestActiveWeek = computed(() => {
  const buckets = nonEmptyWeeklyBuckets.value
  return buckets.length ? buckets[buckets.length - 1] : null
})

const previousActiveWeek = computed(() => {
  const buckets = nonEmptyWeeklyBuckets.value
  return buckets.length > 1 ? buckets[buckets.length - 2] : null
})

const latestProfitDelta = computed(() => {
  if (!latestActiveWeek.value || !previousActiveWeek.value) return null
  return latestActiveWeek.value.gross_profit_total - previousActiveWeek.value.gross_profit_total
})

const totalRealCost = computed(() => totalCost(report.totals))
const negativePeriodRate = computed(() =>
  allPeriodSummary.value.count > 0
    ? allPeriodSummary.value.negativeCount / allPeriodSummary.value.count
    : 0
)

const positiveWeeklyProfitAverage = computed(() => {
  const positives = report.weekly.filter((bucket) => bucket.gross_profit_total > 0)
  if (!positives.length) return 0
  return positives.reduce((sum, bucket) => sum + bucket.gross_profit_total, 0) / positives.length
})

const breakEvenSalesGap = computed(() =>
  Math.max(0, totalRealCost.value - report.totals.sales_total)
)

const salesGapForMargin = (targetMarginPct: number) => {
  const marginRatio = targetMarginPct / 100
  if (totalRealCost.value <= 0 || marginRatio >= 1) return 0
  const requiredSales = totalRealCost.value / (1 - marginRatio)
  return Math.max(0, requiredSales - report.totals.sales_total)
}

const costCutForMargin = (targetMarginPct: number) => {
  const maxCost = report.totals.sales_total * (1 - targetMarginPct / 100)
  return Math.max(0, totalRealCost.value - maxCost)
}

const recoveryWeeksEstimate = computed(() => {
  if (report.totals.gross_profit_total >= 0) return 0
  if (positiveWeeklyProfitAverage.value <= 0) return null
  return Math.ceil(Math.abs(report.totals.gross_profit_total) / positiveWeeklyProfitAverage.value)
})

const investmentScore = computed(() => {
  if (executiveApiReport.value?.decision) return executiveApiReport.value.decision.score

  const marginScore = clamp(((report.totals.margin_pct + 10) / 35) * 40, 0, 40)
  const stabilityScore = clamp((1 - negativePeriodRate.value) * 25, 0, 25)
  const balanceScore = report.totals.balance_total >= 0 ? 15 : clamp(15 + (report.totals.balance_total / 5000) * 15, 0, 15)
  const profitScore = report.totals.gross_profit_total > 0 ? 20 : clamp(20 + (report.totals.gross_profit_total / 5000) * 20, 0, 20)
  return Math.round(clamp(marginScore + stabilityScore + balanceScore + profitScore, 0, 100))
})

const executiveDecision = computed(() => {
  if (executiveApiReport.value?.decision) {
    return {
      tone: executiveApiReport.value.decision.tone,
      label: executiveApiReport.value.decision.label,
      title: executiveApiReport.value.decision.title,
      copy: executiveApiReport.value.decision.copy
    }
  }

  if (report.totals.sales_total <= 0 && totalRealCost.value <= 0) {
    return {
      tone: 'neutral' as ExecutiveDecisionTone,
      label: 'Esperar datos',
      title: 'Aún no hay base suficiente para decidir inversión.',
      copy: 'Se necesita venta, costo real e inventario promedio para emitir una recomendación ejecutiva confiable.'
    }
  }

  if (report.totals.gross_profit_total < 0 || report.totals.net_after_profit_share < 0) {
    return {
      tone: 'critical' as ExecutiveDecisionTone,
      label: 'Corregir antes de invertir',
      title: 'No conviene seguir inyectando capital sin corregir precio, costo o merma.',
      copy: 'La operación todavía no cubre el costo real del periodo. La prioridad es recuperar margen y estabilizar semanas negativas.'
    }
  }

  if (report.totals.margin_pct < 15 || allPeriodSummary.value.negativeCount > 0 || report.totals.balance_total < 0) {
    return {
      tone: 'warning' as ExecutiveDecisionTone,
      label: 'Pausar expansión',
      title: 'La papelería puede seguir operando, pero la inversión debe ser selectiva.',
      copy: 'Hay señales mixtas: margen ajustado, periodos en alerta o balance débil. Conviene comprar solo lo probado y ajustar precios.'
    }
  }

  if (investmentScore.value >= 75) {
    return {
      tone: 'good' as ExecutiveDecisionTone,
      label: 'Invertir con control',
      title: 'Hay base para continuar invirtiendo con límites por categoría y reposición.',
      copy: 'La decisión debe mantenerse condicionada a rotación de inventario, margen mínimo y revisión semanal de productos lentos.'
    }
  }

  return {
    tone: 'neutral' as ExecutiveDecisionTone,
    label: 'Mantener y medir',
    title: 'La operación luce defendible, pero aún no justifica acelerar inversión.',
    copy: 'Mantén el capital actual, mide rotación y prioriza productos con venta repetida antes de aumentar stock.'
  }
})

const decisionToneClassMap: Record<ExecutiveDecisionTone, string> = {
  critical: 'border-rose-200 bg-rose-50 text-rose-700',
  warning: 'border-amber-200 bg-amber-50 text-amber-700',
  good: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  neutral: 'border-slate-200 bg-slate-50 text-slate-700'
}

const decisionToneClass = (tone: ExecutiveDecisionTone) => decisionToneClassMap[tone]

const executiveSignals = computed<ExecutiveSignal[]>(() => [
  {
    key: 'margin',
    label: 'Margen bruto',
    value: formatPercent(report.totals.margin_pct),
    helper: 'Meta ejecutiva: mínimo 15%; saludable desde 25%.',
    tone: report.totals.margin_pct >= 25 ? 'good' : report.totals.margin_pct >= 15 ? 'warning' : 'critical',
    progress: clamp((report.totals.margin_pct / 25) * 100, 0, 100)
  },
  {
    key: 'stability',
    label: 'Estabilidad semanal',
    value: `${formatCount(allPeriodSummary.value.positiveCount)} / ${formatCount(allPeriodSummary.value.count)}`,
    helper: 'Semanas positivas sobre semanas visibles.',
    tone: allPeriodSummary.value.negativeCount === 0 ? 'good' : negativePeriodRate.value <= 0.25 ? 'warning' : 'critical',
    progress: clamp((1 - negativePeriodRate.value) * 100, 0, 100)
  },
  {
    key: 'balance',
    label: 'Balance caja-stock',
    value: formatMoney(report.totals.balance_total),
    helper: 'Ventas totales menos compras del periodo.',
    tone: report.totals.balance_total >= 0 ? 'good' : 'critical',
    progress: report.totals.balance_total >= 0 ? 100 : clamp(100 + (report.totals.balance_total / Math.max(report.totals.purchases_total, 1)) * 100, 0, 100)
  },
  {
    key: 'gmroi',
    label: 'GMROI / rotación',
    value: 'Pendiente',
    helper: 'Requiere inventario promedio; no se debe decidir expansión fuerte sin ese dato.',
    tone: 'warning',
    progress: 35
  }
])

const scenarioCards = computed<ExecutiveScenario[]>(() => [
  ...(executiveApiReport.value?.scenario_cards?.length ? executiveApiReport.value.scenario_cards : []),
  ...(!executiveApiReport.value?.scenario_cards?.length ? [
  {
    key: 'break_even',
    label: 'Punto de equilibrio',
    value: breakEvenSalesGap.value > 0 ? formatMoney(breakEvenSalesGap.value) : 'Cubierto',
    helper: breakEvenSalesGap.value > 0
      ? 'Venta adicional estimada para cubrir el costo ya registrado.'
      : 'Las ventas ya cubren el costo real registrado.',
    tone: breakEvenSalesGap.value > 0 ? 'critical' : 'good'
  },
  {
    key: 'target_15',
    label: 'Brecha a margen 15%',
    value: salesGapForMargin(15) > 0 ? formatMoney(salesGapForMargin(15)) : 'Cumplido',
    helper: 'Venta adicional necesaria si el costo real se mantiene.',
    tone: salesGapForMargin(15) > 0 ? 'warning' : 'good'
  },
  {
    key: 'target_25',
    label: 'Brecha a margen 25%',
    value: salesGapForMargin(25) > 0 ? formatMoney(salesGapForMargin(25)) : 'Cumplido',
    helper: 'Referencia para una operación más sana antes de escalar stock.',
    tone: salesGapForMargin(25) > 0 ? 'warning' : 'good'
  },
  {
    key: 'cost_cut',
    label: 'Ajuste de costo para 15%',
    value: costCutForMargin(15) > 0 ? formatMoney(costCutForMargin(15)) : 'Sin recorte',
    helper: 'Reducción de costo/merma requerida si no crece la venta.',
    tone: costCutForMargin(15) > 0 ? 'warning' : 'good'
  }
] : [])
])

const executiveScoreRules = computed<ExecutiveScoreRule[]>(() =>
  executiveApiReport.value?.score_rules?.length
    ? executiveApiReport.value.score_rules
    : [
        { label: 'Ventas', value: report.totals.sales_total > 0 ? '+12' : '-12', tone: report.totals.sales_total > 0 ? 'plus' : 'minus' },
        { label: 'Margen', value: report.totals.margin_pct >= 15 ? '+16' : '-16', tone: report.totals.margin_pct >= 15 ? 'plus' : 'minus' },
        { label: 'Utilidad neta', value: report.totals.net_after_profit_share >= 0 ? '+18' : '-18', tone: report.totals.net_after_profit_share >= 0 ? 'plus' : 'minus' },
        { label: 'GMROI', value: estimatedGmroi.value >= 1 ? '+14' : '-14', tone: estimatedGmroi.value >= 1 ? 'plus' : 'minus' },
        { label: 'Meta', value: breakEvenSalesGap.value <= 0 ? '+10' : '-10', tone: breakEvenSalesGap.value <= 0 ? 'plus' : 'minus' },
        { label: 'Stock lento', value: totalStockSlowValue.value <= 0 ? '+6' : '-6', tone: totalStockSlowValue.value <= 0 ? 'plus' : 'minus' },
        { label: 'Días inv.', value: inventoryDays.value !== null && inventoryDays.value <= 45 ? '+5' : '-5', tone: inventoryDays.value !== null && inventoryDays.value <= 45 ? 'plus' : 'minus' },
        { label: 'Caja', value: report.totals.balance_total >= 0 ? '+17' : '-17', tone: report.totals.balance_total >= 0 ? 'plus' : 'minus' }
      ]
)

const executiveRiskItems = computed(() =>
  executiveApiReport.value?.risk_items?.length
    ? executiveApiReport.value.risk_items
    : [
        { key: 'sales', label: 'Ventas', value: report.totals.sales_total > 0 ? 'Activas' : 'Sin venta', tone: report.totals.sales_total > 0 ? 'green' : 'red', icon: report.totals.sales_total > 0 ? '🟢' : '🔴' },
        { key: 'profit', label: 'Utilidad', value: report.totals.gross_profit_total >= 0 ? 'Positiva' : 'Negativa', tone: report.totals.gross_profit_total >= 0 ? 'green' : 'red', icon: report.totals.gross_profit_total >= 0 ? '🟢' : '🔴' },
        { key: 'gmroi', label: 'GMROI', value: totalInventoryValue.value > 0 ? `${estimatedGmroi.value.toFixed(2)}x` : 'S/D', tone: estimatedGmroi.value >= 2 ? 'green' : estimatedGmroi.value >= 1 ? 'amber' : 'red', icon: estimatedGmroi.value >= 2 ? '🟢' : estimatedGmroi.value >= 1 ? '🟡' : '🔴' },
        { key: 'sellthrough', label: 'Sell-through', value: formatPercent(sellThroughPct.value), tone: sellThroughPct.value >= 80 ? 'green' : 'amber', icon: sellThroughPct.value >= 80 ? '🟢' : '🟡' },
        { key: 'inventory', label: 'Inventario', value: inventoryDays.value === null ? 'S/D' : `${formatCount(inventoryDays.value)} días`, tone: inventoryDays.value !== null && inventoryDays.value <= 45 ? 'green' : 'amber', icon: inventoryDays.value !== null && inventoryDays.value <= 45 ? '🟢' : '🟡' },
        { key: 'slow_stock', label: 'Stock lento', value: totalStockSlowValue.value > 0 ? formatMoney(totalStockSlowValue.value) : 'Sin alerta', tone: totalStockSlowValue.value > 0 ? 'red' : 'green', icon: totalStockSlowValue.value > 0 ? '🔴' : '🟢' }
      ]
)

const investmentScenarios = computed(() =>
  executiveApiReport.value?.scenarios?.length
    ? executiveApiReport.value.scenarios
    : [
        { key: 'conservative', title: 'Conservador', value: formatMoney(Math.max(0, breakEvenSalesGap.value)), copy: 'Solo recuperar equilibrio y sostener operación.', tag: 'Mantener operación', recommended: false },
        { key: 'recommended', title: 'Recomendado', value: executiveDecision.value.tone === 'critical' ? 'S/ 0.00' : formatMoney(Math.max(0, report.totals.net_after_profit_share)), copy: 'Invertir solo en productos rentables y de rotación comprobada.', tag: 'Mejor equilibrio', recommended: true },
        { key: 'aggressive', title: 'Agresivo', value: executiveDecision.value.tone === 'good' ? formatMoney(Math.max(0, report.totals.net_after_profit_share * 2)) : 'No recomendado', copy: 'Requiere caja positiva, GMROI sano y semanas sin pérdida.', tag: 'Mayor riesgo', recommended: false }
      ]
)

const goalSummary = computed(() =>
  executiveApiReport.value?.goal || {
    percent: breakEvenSalesGap.value <= 0 ? 100 : clamp((report.totals.sales_total / Math.max(totalRealCost.value, 1)) * 100, 0, 100),
    percentLabel: breakEvenSalesGap.value <= 0 ? '100%' : formatPercent(clamp((report.totals.sales_total / Math.max(totalRealCost.value, 1)) * 100, 0, 100)),
    items: [
      { label: 'Ventas', value: formatMoney(report.totals.sales_total), tone: 'blue' },
      { label: 'Costo', value: formatMoney(totalRealCost.value), tone: 'amber' },
      { label: 'Brecha', value: formatMoney(breakEvenSalesGap.value), tone: breakEvenSalesGap.value <= 0 ? 'green' : 'red' }
    ]
  }
)

const actionItems = computed(() => {
  if (executiveApiReport.value?.actions?.length) return executiveApiReport.value.actions

  const items: Array<{ key: string; title: string; copy: string; tone: ExecutiveDecisionTone }> = []

  if (report.totals.gross_profit_total < 0) {
    items.push({
      key: 'loss',
      title: 'Congelar compras no críticas',
      copy: 'Comprar solo reposición de productos con venta comprobada hasta cubrir la pérdida bruta.',
      tone: 'critical'
    })
  }

  if (report.totals.margin_pct < 15) {
    items.push({
      key: 'price',
      title: 'Revisar precio y costo de reposición',
      copy: 'La brecha de margen exige subir precio, bajar costo o reducir merma antes de ampliar inventario.',
      tone: 'warning'
    })
  }

  if (allPeriodSummary.value.negativeCount > 0) {
    items.push({
      key: 'weeks',
      title: 'Aislar semanas negativas',
      copy: 'Cruzar las semanas en alerta con productos, ajustes de inventario y compras para encontrar el origen.',
      tone: 'warning'
    })
  }

  items.push({
    key: 'inventory',
    title: 'Completar inventario promedio',
    copy: 'Con ese dato se puede agregar GMROI y rotación, dos métricas clave para decidir si el capital está trabajando.',
    tone: 'neutral'
  })

  return items
})

const decisionSentence = computed(() => {
  if (executiveApiReport.value?.decision?.score_text) return executiveApiReport.value.decision.score_text

  if (executiveDecision.value.tone === 'critical') {
    return 'No invertir más capital hasta corregir margen y explicar la pérdida.'
  }

  if (executiveDecision.value.tone === 'warning') {
    return 'No expandir stock; invertir solo en reposición de alta rotación.'
  }

  if (executiveDecision.value.tone === 'good') {
    return 'Continuar inversión con límites semanales y control por producto.'
  }

  return 'Mantener operación y completar datos antes de decidir expansión.'
})

const executiveTakeaways = computed(() => [
  {
    key: 'loss',
    label: 'Resultado real',
    value: formatMoney(report.totals.gross_profit_total),
    helper: report.totals.gross_profit_total < 0 ? 'El negocio consume capital.' : 'El negocio genera utilidad bruta.',
    tone: report.totals.gross_profit_total < 0 ? 'critical' as ExecutiveDecisionTone : 'good' as ExecutiveDecisionTone
  },
  {
    key: 'gap',
    label: 'Venta para empatar',
    value: breakEvenSalesGap.value > 0 ? formatMoney(breakEvenSalesGap.value) : 'Cubierto',
    helper: 'Brecha mínima para cubrir el costo real registrado.',
    tone: breakEvenSalesGap.value > 0 ? 'critical' as ExecutiveDecisionTone : 'good' as ExecutiveDecisionTone
  },
  {
    key: 'alert',
    label: 'Semanas en pérdida',
    value: `${formatCount(allPeriodSummary.value.negativeCount)} de ${formatCount(allPeriodSummary.value.count)}`,
    helper: 'La decisión debe basarse en estabilidad, no en un solo cierre.',
    tone: allPeriodSummary.value.negativeCount > 0 ? 'warning' as ExecutiveDecisionTone : 'good' as ExecutiveDecisionTone
  },
  {
    key: 'margin',
    label: 'Margen',
    value: formatPercent(report.totals.margin_pct),
    helper: 'Meta ejecutiva mínima: 15%.',
    tone: report.totals.margin_pct < 15 ? 'critical' as ExecutiveDecisionTone : 'good' as ExecutiveDecisionTone
  }
])

const bridgeMaxValue = computed(() =>
  Math.max(
    Math.abs(report.totals.sales_total),
    Math.abs(totalRealCost.value),
    Math.abs(report.totals.gross_profit_total),
    1
  )
)

const profitBridge = computed<ProfitBridgeItem[]>(() => [
  {
    key: 'sales',
    label: 'Ventas',
    value: report.totals.sales_total,
    displayValue: formatMoney(report.totals.sales_total),
    helper: 'Ingreso registrado del periodo.',
    tone: 'good',
    width: clamp((Math.abs(report.totals.sales_total) / bridgeMaxValue.value) * 100, 4, 100)
  },
  {
    key: 'cost',
    label: 'Costo real',
    value: totalRealCost.value,
    displayValue: formatMoney(totalRealCost.value),
    helper: 'Costo consumido por ventas y ajustes.',
    tone: 'critical',
    width: clamp((Math.abs(totalRealCost.value) / bridgeMaxValue.value) * 100, 4, 100)
  },
  {
    key: 'profit',
    label: report.totals.gross_profit_total >= 0 ? 'Ganancia' : 'Pérdida',
    value: report.totals.gross_profit_total,
    displayValue: formatMoney(report.totals.gross_profit_total),
    helper: 'Resultado antes de participación.',
    tone: report.totals.gross_profit_total >= 0 ? 'good' : 'critical',
    width: clamp((Math.abs(report.totals.gross_profit_total) / bridgeMaxValue.value) * 100, 4, 100)
  }
])

const weeklyDecisionMax = computed(() =>
  Math.max(...report.weekly.map((bucket) => Math.abs(bucket.gross_profit_total)), 1)
)

const weeklyDecisionPoints = computed<WeeklyDecisionPoint[]>(() =>
  report.weekly
    .filter((bucket) => Math.abs(bucket.sales_total) > 0 || Math.abs(bucket.gross_profit_total) > 0)
    .slice(-12)
    .map((bucket) => ({
      key: bucket.key,
      label: bucket.label,
      value: bucket.gross_profit_total,
      displayValue: formatMoney(bucket.gross_profit_total),
      sales: formatMoney(bucket.sales_total),
      margin: formatPercent(bucket.margin_pct),
      tone: bucket.gross_profit_total >= 0 ? 'good' : 'critical',
      width: clamp((Math.abs(bucket.gross_profit_total) / weeklyDecisionMax.value) * 100, 4, 100)
    }))
)

const totalInventoryValue = computed(() =>
  productItems.value.reduce((sum, item) => sum + Number(item.inventory_value || 0), 0)
)

const totalStockSlowValue = computed(() =>
  productItems.value
    .filter((item) => {
      const days = daysBetween(item.last_sale_at, reportPeriodEnd.value || toDateKey(generatedAt.value))
      return Number(item.stock_on_hand || 0) > 0 && (days === null || days > 60)
    })
    .reduce((sum, item) => sum + Number(item.inventory_value || 0), 0)
)

const estimatedGmroi = computed(() =>
  totalInventoryValue.value > 0
    ? report.totals.gross_profit_total / totalInventoryValue.value
    : 0
)

const sellThroughPct = computed(() => {
  const purchases = Number(report.totals.purchases_total || 0)
  if (purchases <= 0) return 0
  return (report.totals.sales_total / purchases) * 100
})

const inventoryDays = computed(() => {
  const cost = totalRealCost.value
  if (cost <= 0 || totalInventoryValue.value <= 0) return null
  const periodDays = Math.max(daysBetween(reportPeriodStart.value, reportPeriodEnd.value || toDateKey(generatedAt.value)) || 1, 1)
  return Math.round((totalInventoryValue.value / cost) * periodDays)
})

const executiveDashboardKpis = computed<ExecutiveKpiCard[]>(() => [
  ...(executiveApiReport.value?.kpis?.length ? executiveApiReport.value.kpis : []),
  ...(!executiveApiReport.value?.kpis?.length ? [
  {
    key: 'sales',
    title: 'Ventas',
    value: formatMoney(report.totals.sales_total),
    icon: '💰',
    iconBg: '#dbeafe',
    helper: report.totals.sales_total > 0 ? 'Ingreso registrado' : 'Sin venta',
    trendClass: report.totals.sales_total > 0 ? 'trend' : 'trend red'
  },
  {
    key: 'net',
    title: 'Utilidad neta',
    value: formatMoney(report.totals.net_after_profit_share),
    icon: '✅',
    iconBg: '#dcfce7',
    helper: report.totals.net_after_profit_share >= 0 ? 'Neta después del 10%' : 'Negativa',
    trendClass: report.totals.net_after_profit_share >= 0 ? 'trend' : 'trend red'
  },
  {
    key: 'gmroi',
    title: 'GMROI',
    value: totalInventoryValue.value > 0 ? `${estimatedGmroi.value.toFixed(2)}x` : 'S/D',
    icon: '📈',
    iconBg: '#ede9fe',
    helper: totalInventoryValue.value > 0 ? 'Utilidad bruta / inventario' : 'Falta inventario valorizado',
    trendClass: estimatedGmroi.value >= 2 ? 'trend' : estimatedGmroi.value >= 1 ? 'trend warn' : 'trend red'
  },
  {
    key: 'sellthrough',
    title: 'Sell-through',
    value: formatPercent(sellThroughPct.value),
    icon: '🔁',
    iconBg: '#dcfce7',
    helper: sellThroughPct.value >= 80 ? 'Bueno' : 'Bajo',
    trendClass: sellThroughPct.value >= 80 ? 'trend' : 'trend warn'
  },
  {
    key: 'inventory_days',
    title: 'Días inventario',
    value: inventoryDays.value === null ? 'S/D' : `${formatCount(inventoryDays.value)} días`,
    icon: '📦',
    iconBg: '#ffedd5',
    helper: inventoryDays.value === null ? 'Sin base' : inventoryDays.value <= 45 ? 'Meta 30-45' : 'Sobre meta',
    trendClass: inventoryDays.value !== null && inventoryDays.value <= 45 ? 'trend' : 'trend warn'
  },
  {
    key: 'cash',
    title: 'Caja neta',
    value: formatMoney(report.totals.balance_total),
    icon: '🏦',
    iconBg: '#ccfbf1',
    helper: report.totals.balance_total >= 0 ? 'Positiva' : 'Presión de caja',
    trendClass: report.totals.balance_total >= 0 ? 'trend' : 'trend red'
  },
  {
    key: 'slow_stock',
    title: 'Stock lento',
    value: totalInventoryValue.value > 0 ? formatMoney(totalStockSlowValue.value) : 'S/D',
    icon: '⚠️',
    iconBg: '#fee2e2',
    helper: totalStockSlowValue.value > 0 ? 'Capital inmovilizado' : 'Sin alerta',
    trendClass: totalStockSlowValue.value > 0 ? 'trend red' : 'trend'
  }
] : [])
])

const monthlySalesChart = computed(() => {
  const values = report.monthly.map((bucket) => Number(bucket.sales_total || 0))
  const max = Math.max(...values, 1)
  return report.monthly.map((bucket, index) => ({
    key: bucket.key,
    label: bucket.label,
    value: values[index],
    displayValue: formatMoney(values[index]),
    height: clamp((values[index] / max) * 100, 4, 100)
  }))
})

const waterfallBars = computed<SimpleBarDatum[]>(() => {
  if (executiveApiReport.value?.charts?.waterfall?.items?.length) {
    return chartItemsWithWidth(executiveApiReport.value.charts.waterfall.items)
  }

  const rows = [
    { key: 'sales', label: 'Ventas', value: report.totals.sales_total, color: '#2563eb' },
    { key: 'cost', label: 'Costo', value: totalRealCost.value, color: '#dc2626' },
    { key: 'gross', label: 'Util. bruta', value: report.totals.gross_profit_total, color: report.totals.gross_profit_total >= 0 ? '#16a34a' : '#dc2626' },
    { key: 'share', label: '10%', value: report.totals.profit_ten_percent, color: '#f59e0b' },
    { key: 'net', label: 'Neto', value: report.totals.net_after_profit_share, color: report.totals.net_after_profit_share >= 0 ? '#16a34a' : '#dc2626' }
  ]
  const max = Math.max(...rows.map((row) => Math.abs(row.value)), 1)
  return rows.map((row) => ({
    ...row,
    displayValue: formatMoney(row.value),
    width: clamp((Math.abs(row.value) / max) * 100, 4, 100)
  }))
})

const recoveryBars = computed<SimpleBarDatum[]>(() => {
  if (executiveApiReport.value?.charts?.recovery?.items?.length) {
    return chartItemsWithWidth(executiveApiReport.value.charts.recovery.items)
  }

  const rows = [
    { key: 'purchases', label: 'Compras', value: report.totals.purchases_total, color: '#2563eb' },
    { key: 'sales', label: 'Ventas', value: report.totals.sales_total, color: '#16a34a' },
    { key: 'cogs', label: 'Costo vend.', value: totalRealCost.value, color: '#dc2626' },
    { key: 'inventory', label: 'Stock', value: totalInventoryValue.value, color: '#f59e0b' },
    { key: 'slow', label: 'Estanc.', value: totalStockSlowValue.value, color: '#991b1b' }
  ]
  const max = Math.max(...rows.map((row) => Math.abs(row.value)), 1)
  return rows.map((row) => ({
    ...row,
    displayValue: formatMoney(row.value),
    width: clamp((Math.abs(row.value) / max) * 100, 4, 100)
  }))
})

const cashBars = computed<SimpleBarDatum[]>(() => {
  if (executiveApiReport.value?.charts?.cash?.items?.length) {
    return chartItemsWithWidth(executiveApiReport.value.charts.cash.items)
  }

  const rows = [
    { key: 'sales', label: 'Cobros', value: report.totals.sales_total, color: '#16a34a' },
    { key: 'suppliers', label: 'Proveedores', value: report.totals.purchases_total, color: '#dc2626' },
    { key: 'share', label: '10%', value: report.totals.profit_ten_percent, color: '#f59e0b' },
    { key: 'net', label: 'Caja neta', value: report.totals.balance_total, color: report.totals.balance_total >= 0 ? '#2563eb' : '#dc2626' }
  ]
  const max = Math.max(...rows.map((row) => Math.abs(row.value)), 1)
  return rows.map((row) => ({
    ...row,
    displayValue: formatMoney(row.value),
    width: clamp((Math.abs(row.value) / max) * 100, 4, 100)
  }))
})

const categoryMetrics = computed<CategoryMetric[]>(() => {
  if (executiveApiReport.value?.charts?.gmroi?.items?.length) {
    return categoryItemsWithWidth(executiveApiReport.value.charts.gmroi.items)
  }

  const buckets = new Map<string, { profit: number; inventory: number; sales: number }>()

  for (const item of productItems.value) {
    const key = item.category_name || 'Sin categoría'
    const current = buckets.get(key) || { profit: 0, inventory: 0, sales: 0 }
    const margin = Number(item.margin_pct || 0) / 100
    current.profit += Number(item.sales_total || 0) * margin
    current.inventory += Number(item.inventory_value || 0)
    current.sales += Number(item.sales_total || 0)
    buckets.set(key, current)
  }

  const rows = Array.from(buckets.entries())
    .map(([label, value]) => {
      const gmroi = value.inventory > 0 ? value.profit / value.inventory : 0
      return { label, value: gmroi }
    })
    .sort((a, b) => b.value - a.value)
    .slice(0, 5)

  const max = Math.max(...rows.map((row) => Math.abs(row.value)), 1)
  return rows.map((row) => ({
    key: row.label,
    label: row.label,
    value: row.value,
    displayValue: `${row.value.toFixed(2)}x`,
    color: row.value >= 2 ? '#16a34a' : row.value >= 1 ? '#f59e0b' : '#dc2626',
    width: clamp((Math.abs(row.value) / max) * 100, 4, 100),
    status: row.value >= 2 ? 'Invertir' : row.value >= 1 ? 'Revisar' : 'No aumentar'
  }))
})

const inventoryMix = computed(() => {
  if (executiveApiReport.value?.charts?.inventory?.items?.length) {
    return executiveApiReport.value.charts.inventory.items.map((item) => ({
      label: item.label,
      value: Number(item.value || 0),
      color: item.color
    }))
  }

  const total = Math.max(productItems.value.length, 1)
  const high = productItems.value.filter((item) => Number(item.sales_total || 0) > 0 && Number(item.stock_on_hand || 0) > 0).length
  const medium = productItems.value.filter((item) => Number(item.sales_total || 0) > 0 && Number(item.stock_on_hand || 0) <= 0).length
  const slow = productItems.value.filter((item) => Number(item.sales_total || 0) <= 0 && Number(item.stock_on_hand || 0) > 0).length
  const stale = productItems.value.filter((item) => {
    const days = daysBetween(item.last_sale_at, reportPeriodEnd.value || toDateKey(generatedAt.value))
    return Number(item.stock_on_hand || 0) > 0 && days !== null && days > 90
  }).length

  return [
    { label: 'Alta rotación', value: Math.round((high / total) * 100), color: '#16a34a' },
    { label: 'Media', value: Math.round((medium / total) * 100), color: '#f59e0b' },
    { label: 'Baja', value: Math.round((slow / total) * 100), color: '#dc2626' },
    { label: 'Estancado', value: Math.round((stale / total) * 100), color: '#94a3b8' }
  ]
})

const inventoryDonutStyle = computed(() => {
  let start = 0
  const parts = inventoryMix.value.map((item) => {
    const end = start + item.value
    const part = `${item.color} ${start}% ${end}%`
    start = end
    return part
  })

  return {
    background: `conic-gradient(${parts.join(', ')})`
  }
})

const agingBars = computed<SimpleBarDatum[]>(() => {
  if (executiveApiReport.value?.charts?.aging?.items?.length) {
    return chartItemsWithWidth(executiveApiReport.value.charts.aging.items)
  }

  const end = reportPeriodEnd.value || toDateKey(generatedAt.value)
  const rows = [
    { key: '0_30', label: '0-30 días', value: 0, color: '#16a34a' },
    { key: '31_60', label: '31-60 días', value: 0, color: '#f59e0b' },
    { key: '61_90', label: '61-90 días', value: 0, color: '#f59e0b' },
    { key: '90_plus', label: '+90 días', value: 0, color: '#dc2626' }
  ]

  for (const item of productItems.value) {
    if (Number(item.stock_on_hand || 0) <= 0) continue
    const days = daysBetween(item.last_sale_at, end)
    const value = Number(item.inventory_value || 0)
    if (days === null || days > 90) rows[3].value += value
    else if (days > 60) rows[2].value += value
    else if (days > 30) rows[1].value += value
    else rows[0].value += value
  }

  const max = Math.max(...rows.map((row) => row.value), 1)
  return rows.map((row) => ({
    ...row,
    displayValue: formatMoney(row.value),
    width: clamp((row.value / max) * 100, 4, 100)
  }))
})

const profitByCategory = computed<CategoryMetric[]>(() => {
  if (executiveApiReport.value?.charts?.profit?.items?.length) {
    return categoryItemsWithWidth(executiveApiReport.value.charts.profit.items)
  }

  const buckets = new Map<string, { sales: number; profit: number }>()
  for (const item of productItems.value) {
    const key = item.category_name || 'Sin categoría'
    const current = buckets.get(key) || { sales: 0, profit: 0 }
    const margin = Number(item.margin_pct || 0) / 100
    current.sales += Number(item.sales_total || 0)
    current.profit += Number(item.sales_total || 0) * margin
    buckets.set(key, current)
  }

  const rows = Array.from(buckets.entries())
    .map(([label, value]) => ({
      label,
      value: value.sales > 0 ? (value.profit / value.sales) * 100 : 0
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 5)

  const max = Math.max(...rows.map((row) => Math.abs(row.value)), 1)
  return rows.map((row) => ({
    key: row.label,
    label: row.label,
    value: row.value,
    displayValue: `${formatMoney(row.value)}`,
    color: row.value >= 25 ? '#16a34a' : row.value >= 15 ? '#f59e0b' : '#dc2626',
    width: clamp((Math.abs(row.value) / max) * 100, 4, 100),
    status: row.value >= 25 ? 'Comprar' : row.value >= 15 ? 'Revisar' : 'Corregir'
  }))
})

const overviewHeadline = computed(() => {
  const total = report.totals
  if (total.gross_profit_total < 0) return 'La operación total está en pérdida y requiere corrección inmediata.'
  if (focusBucketsSummary.value.negativeCount > 0) return 'La operación es rentable, pero hay periodos en alerta.'
  if (total.margin_pct >= 25) return 'La rentabilidad es sólida y tiene base para acelerar inversión.'
  return 'La operación es positiva, pero el margen sigue apretado.'
})

const overviewCopy = computed(() => {
  const total = report.totals
  if (total.gross_profit_total < 0) {
    return 'No conviene escalar inversión hasta revisar precios, costo de reposición y pérdidas operativas.'
  }
  if (focusBucketsSummary.value.negativeCount > 0) {
    return 'Hay semanas o meses débiles; conviene aislar qué productos o costos están empujando la caída.'
  }
  if (total.margin_pct >= 25) {
    return 'La dirección puede usar esta rentabilidad como base para expandir inventario, mix y cobertura comercial.'
  }
  return 'La rentabilidad existe, pero vale más proteger el margen que buscar crecimiento desordenado.'
})

const overviewChips = computed(() => [
  {
    label: 'Margen total',
    value: formatPercent(report.totals.margin_pct)
  },
  {
    label: 'Periodos en alerta',
    value: formatCount(focusBucketsSummary.value.negativeCount)
  },
  {
    label: 'Neto 10%',
    value: formatMoney(report.totals.net_after_profit_share)
  }
])

const executiveKpis = computed(() => [
  {
    key: 'sales_total',
    label: 'Ventas totales',
    value: formatMoney(report.totals.sales_total),
    helper: `Registradas ${formatMoney(report.totals.sales_recorded_total)} · Ajustes ${formatMoney(report.totals.sales_from_adjustment_total)}`,
    tone: 'indigo'
  },
  {
    key: 'cost_total',
    label: 'Costo total',
    value: formatMoney(totalCost(report.totals)),
    helper: `Compras ${formatMoney(report.totals.purchases_total)} · Costo real ${formatMoney(report.totals.sales_cogs_total + report.totals.adjustments_cogs_total)}`,
    tone: 'rose'
  },
  {
    key: 'gross_profit',
    label: 'Ganancia bruta',
    value: formatMoney(report.totals.gross_profit_total),
    helper: 'Ventas menos costo real del periodo.',
    tone: report.totals.gross_profit_total >= 0 ? 'emerald' : 'rose'
  },
  {
    key: 'margin',
    label: 'Margen',
    value: formatPercent(report.totals.margin_pct),
    helper: 'Ganancia sobre ventas totales.',
    tone: report.totals.margin_pct >= 20 ? 'emerald' : 'amber'
  },
  {
    key: 'balance',
    label: 'Balance',
    value: formatMoney(report.totals.balance_total),
    helper: 'Ventas totales menos compras del periodo.',
    tone: report.totals.balance_total >= 0 ? 'cyan' : 'rose'
  },
  {
    key: 'profit_share',
    label: '10% de la ganancia',
    value: formatMoney(report.totals.profit_ten_percent),
    helper: `Neto después del 10%: ${formatMoney(report.totals.net_after_profit_share)}`,
    tone: 'slate'
  }
])

const selectedFocusTone = computed(() => {
  if (selectedFocus.value === 'total') return 'slate'
  if (focusBucketsSummary.value.negativeCount > 0) return 'rose'
  if (focusBucketsSummary.value.averageMargin >= 25) return 'emerald'
  if (focusBucketsSummary.value.averageMargin >= 15) return 'amber'
  return 'indigo'
})

const toneClassMap: Record<string, string> = {
  indigo: 'border-indigo-200 bg-indigo-50 text-indigo-700',
  rose: 'border-rose-200 bg-rose-50 text-rose-700',
  emerald: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  amber: 'border-amber-200 bg-amber-50 text-amber-700',
  cyan: 'border-cyan-200 bg-cyan-50 text-cyan-700',
  slate: 'border-slate-200 bg-slate-50 text-slate-700'
}

const toneClass = (tone: string) => toneClassMap[tone] || toneClassMap.slate

const pickFocusSectionId = (focus: ExecutiveFocus) => focusTargetByKey[focus]

const setFocus = (focus: ExecutiveFocus) => {
  selectedFocus.value = focus
  if (typeof window === 'undefined') return

  window.requestAnimationFrame(() => {
    const element = document.getElementById(pickFocusSectionId(focus))
    element?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })
}

const chartColors = {
  blue: '#2563eb',
  green: '#16a34a',
  amber: '#f59e0b',
  red: '#dc2626',
  purple: '#7c3aed',
  gray: '#94a3b8',
  grid: '#e2e8f0',
  text: '#475569',
  dark: '#0f172a'
}

const shortMoney = (value: number) => {
  const amount = Number(value || 0)
  const sign = amount < 0 ? '-' : ''
  const abs = Math.abs(amount)
  return `${sign}S/${abs >= 1000 ? `${(abs / 1000).toFixed(1)}K` : abs.toFixed(0)}`
}

const shortNumber = (value: number) => {
  const amount = Number(value || 0)
  if (Math.abs(amount) >= 1000) return `${(amount / 1000).toFixed(1)}K`
  return amount.toFixed(0)
}

const setupCanvas = (canvas: HTMLCanvasElement | null) => {
  if (!canvas) return null
  const rect = canvas.getBoundingClientRect()
  const width = Math.max(rect.width, 1)
  const height = Math.max(rect.height, 1)
  const dpr = window.devicePixelRatio || 1
  canvas.width = width * dpr
  canvas.height = height * dpr
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return { ctx, width, height }
}

const drawText = (
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  options: { color?: string; font?: string; align?: CanvasTextAlign } = {}
) => {
  ctx.fillStyle = options.color || chartColors.text
  ctx.font = options.font || '12px Arial'
  ctx.textAlign = options.align || 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, x, y)
}

const drawRoundRect = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) => {
  const rounded = Math.min(radius, width / 2, height / 2)
  ctx.beginPath()
  ctx.moveTo(x + rounded, y)
  ctx.arcTo(x + width, y, x + width, y + height, rounded)
  ctx.arcTo(x + width, y + height, x, y + height, rounded)
  ctx.arcTo(x, y + height, x, y, rounded)
  ctx.arcTo(x, y, x + width, y, rounded)
  ctx.closePath()
}

const drawGrid = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  padding: { l: number; r: number; t: number; b: number },
  max: number,
  steps = 5
) => {
  const chartHeight = height - padding.t - padding.b
  for (let index = 0; index <= steps; index += 1) {
    const y = padding.t + (chartHeight / steps) * index
    const value = max - (max / steps) * index
    ctx.beginPath()
    ctx.moveTo(padding.l, y)
    ctx.lineTo(width - padding.r, y)
    ctx.strokeStyle = chartColors.grid
    ctx.lineWidth = 1
    ctx.stroke()
    drawText(ctx, shortNumber(value), padding.l - 12, y, { align: 'right' })
  }
}

const drawSalesChart = () => {
  const setup = setupCanvas(salesChartCanvas.value)
  if (!setup) return
  const { ctx, width, height } = setup
  const apiSalesChart = executiveApiReport.value?.charts?.sales
  const buckets = report.monthly.length ? report.monthly : [report.totals]
  const values = apiSalesChart
    ? (selectedSalesMode.value === 'ventas' ? apiSalesChart.ventas : apiSalesChart.unidades).map((value) => Math.max(0, Number(value || 0)))
    : buckets.map((bucket) =>
        selectedSalesMode.value === 'ventas'
          ? Math.max(0, Number(bucket.sales_total || 0))
          : Math.max(0, Number(bucket.sale_items_count || 0))
      )
  const labels = apiSalesChart ? apiSalesChart.labels : buckets.map((bucket) => bucket.label)
  const max = Math.max(1, ...values) * 1.15
  const padding = { l: 52, r: 18, t: 22, b: 34 }
  const chartWidth = width - padding.l - padding.r
  const chartHeight = height - padding.t - padding.b

  ctx.clearRect(0, 0, width, height)
  drawGrid(ctx, width, height, padding, max)

  const points = values.map((value, index) => {
    const divisor = Math.max(values.length - 1, 1)
    return {
      x: values.length === 1 ? padding.l + chartWidth / 2 : padding.l + (chartWidth / divisor) * index,
      y: padding.t + chartHeight - (value / max) * chartHeight
    }
  })

  if (!points.length) return

  const gradient = ctx.createLinearGradient(0, padding.t, 0, height - padding.b)
  gradient.addColorStop(0, 'rgba(37,99,235,.24)')
  gradient.addColorStop(1, 'rgba(37,99,235,.02)')
  ctx.beginPath()
  ctx.moveTo(points[0].x, height - padding.b)
  points.forEach((point) => ctx.lineTo(point.x, point.y))
  ctx.lineTo(points[points.length - 1].x, height - padding.b)
  ctx.fillStyle = gradient
  ctx.fill()

  ctx.beginPath()
  points.forEach((point, index) => {
    if (index === 0) {
      ctx.moveTo(point.x, point.y)
      return
    }
    const previous = points[index - 1]
    const cp = (previous.x + point.x) / 2
    ctx.bezierCurveTo(cp, previous.y, cp, point.y, point.x, point.y)
  })
  ctx.strokeStyle = chartColors.blue
  ctx.lineWidth = 3
  ctx.stroke()

  points.forEach((point, index) => {
    ctx.beginPath()
    ctx.arc(point.x, point.y, 5, 0, Math.PI * 2)
    ctx.fillStyle = '#fff'
    ctx.fill()
    ctx.strokeStyle = chartColors.blue
    ctx.lineWidth = 3
    ctx.stroke()
    const label = selectedSalesMode.value === 'ventas' ? shortMoney(values[index]) : formatCount(values[index])
    drawText(ctx, label, point.x, point.y - 17, {
      align: 'center',
      font: 'bold 12px Arial',
      color: chartColors.blue
    })
    drawText(ctx, labels[index], point.x, height - 13, { align: 'center' })
  })
}

const drawBarsChart = (
  canvas: HTMLCanvasElement | null,
  labels: string[],
  values: number[],
  colors: string[]
) => {
  const setup = setupCanvas(canvas)
  if (!setup) return
  const { ctx, width, height } = setup
  const absoluteValues = values.map((value) => Math.abs(Number(value || 0)))
  const max = Math.max(1, ...absoluteValues) * 1.15
  const padding = { l: 64, r: 18, t: 24, b: 48 }
  const chartWidth = width - padding.l - padding.r
  const chartHeight = height - padding.t - padding.b
  const gap = Math.min(22, chartWidth / Math.max(labels.length * 5, 1))
  const barWidth = Math.max(10, (chartWidth - gap * (values.length - 1)) / Math.max(values.length, 1))

  ctx.clearRect(0, 0, width, height)
  drawGrid(ctx, width, height, padding, max)

  values.forEach((value, index) => {
    const absolute = absoluteValues[index]
    const barHeight = (absolute / max) * chartHeight
    const x = padding.l + index * (barWidth + gap)
    const y = padding.t + chartHeight - barHeight
    ctx.fillStyle = colors[index]
    drawRoundRect(ctx, x, y, barWidth, barHeight, 9)
    ctx.fill()
    drawText(ctx, shortMoney(value), x + barWidth / 2, y - 13, {
      align: 'center',
      font: 'bold 12px Arial',
      color: chartColors.dark
    })
    drawText(ctx, labels[index], x + barWidth / 2, height - 18, { align: 'center', font: '12px Arial' })
  })
}

const drawHorizontalChart = (
  canvas: HTMLCanvasElement | null,
  labels: string[],
  values: number[],
  colors: string[],
  formatter: (value: number) => string,
  withStatus = false
) => {
  const setup = setupCanvas(canvas)
  if (!setup) return
  const { ctx, width, height } = setup
  const max = Math.max(1, ...values.map((value) => Math.abs(Number(value || 0)))) * 1.15
  const padding = { l: 105, r: withStatus ? 70 : 18, t: 16, b: 20 }
  const chartWidth = width - padding.l - padding.r
  const rowHeight = (height - padding.t - padding.b) / Math.max(labels.length, 1)

  ctx.clearRect(0, 0, width, height)

  labels.forEach((label, index) => {
    const value = Number(values[index] || 0)
    const y = padding.t + index * rowHeight + rowHeight * 0.22
    const barHeight = Math.min(28, rowHeight * 0.56)
    const barWidth = Math.max(4, (Math.abs(value) / max) * chartWidth)

    drawText(ctx, label, padding.l - 12, y + barHeight / 2, {
      align: 'right',
      font: 'bold 13px Arial',
      color: '#334155'
    })

    ctx.fillStyle = '#eef2f7'
    drawRoundRect(ctx, padding.l, y, chartWidth, barHeight, 999)
    ctx.fill()

    ctx.fillStyle = colors[index]
    drawRoundRect(ctx, padding.l, y, barWidth, barHeight, 999)
    ctx.fill()

    const inside = barWidth > 54
    drawText(ctx, formatter(value), inside ? padding.l + barWidth - 10 : padding.l + barWidth + 8, y + barHeight / 2, {
      align: inside ? 'right' : 'left',
      font: 'bold 12px Arial',
      color: inside ? '#fff' : '#0f172a'
    })

    if (withStatus) {
      const status = value >= 2 ? 'Invertir' : value >= 1 ? 'Revisar' : 'No aumentar'
      const statusColor = value >= 2 ? chartColors.green : value >= 1 ? chartColors.amber : chartColors.red
      ctx.fillStyle = statusColor
      drawRoundRect(ctx, width - 62, y + 3, 52, Math.max(barHeight - 6, 16), 999)
      ctx.fill()
      drawText(ctx, status, width - 36, y + barHeight / 2, {
        align: 'center',
        font: 'bold 9px Arial',
        color: '#fff'
      })
    }
  })
}

const drawInventoryDonut = () => {
  const setup = setupCanvas(inventoryChartCanvas.value)
  if (!setup) return
  const { ctx, width, height } = setup
  const data = inventoryMix.value
  const cx = width * 0.36
  const cy = height / 2
  const radius = Math.min(width, height) * 0.34
  const innerRadius = radius * 0.64
  let angle = -Math.PI / 2

  ctx.clearRect(0, 0, width, height)

  data.forEach((item) => {
    const segment = (item.value / 100) * Math.PI * 2
    ctx.beginPath()
    ctx.arc(cx, cy, radius, angle, angle + segment)
    ctx.arc(cx, cy, innerRadius, angle + segment, angle, true)
    ctx.closePath()
    ctx.fillStyle = item.color
    ctx.fill()
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 4
    ctx.stroke()
    angle += segment
  })

  drawText(ctx, totalInventoryValue.value > 0 ? estimatedGmroi.value.toFixed(1) : 'S/D', cx, cy - 9, {
    align: 'center',
    font: 'bold 34px Arial',
    color: chartColors.dark
  })
  drawText(ctx, 'veces', cx, cy + 20, { align: 'center', font: 'bold 13px Arial' })

  const legendX = width * 0.63
  const legendY = cy - 58
  data.forEach((item, index) => {
    const y = legendY + index * 34
    ctx.beginPath()
    ctx.arc(legendX, y, 6, 0, Math.PI * 2)
    ctx.fillStyle = item.color
    ctx.fill()
    drawText(ctx, item.label, legendX + 14, y, { font: 'bold 13px Arial', color: '#334155' })
    drawText(ctx, `${item.value}%`, width - 16, y, {
      align: 'right',
      font: 'bold 13px Arial',
      color: chartColors.dark
    })
  })
}

const drawAllCharts = () => {
  if (typeof window === 'undefined') return

  drawSalesChart()
  drawBarsChart(
    waterfallChartCanvas.value,
    waterfallBars.value.map((bar) => bar.label),
    waterfallBars.value.map((bar) => bar.value),
    waterfallBars.value.map((bar) => bar.color)
  )
  drawBarsChart(
    recoveryChartCanvas.value,
    recoveryBars.value.map((bar) => bar.label),
    recoveryBars.value.map((bar) => bar.value),
    recoveryBars.value.map((bar) => bar.color)
  )
  drawBarsChart(
    cashChartCanvas.value,
    cashBars.value.map((bar) => bar.label),
    cashBars.value.map((bar) => bar.value),
    cashBars.value.map((bar) => bar.color)
  )
  drawHorizontalChart(
    gmroiChartCanvas.value,
    categoryMetrics.value.map((bar) => bar.label),
    categoryMetrics.value.map((bar) => bar.value),
    categoryMetrics.value.map((bar) => bar.color),
    (value) => `${value.toFixed(1)}x`,
    true
  )
  drawInventoryDonut()
  drawHorizontalChart(
    agingChartCanvas.value,
    agingBars.value.map((bar) => bar.label),
    agingBars.value.map((bar) => bar.value),
    agingBars.value.map((bar) => bar.color),
    (value) => shortMoney(value)
  )
}

const scheduleChartRedraw = () => {
  if (typeof window === 'undefined') return
  if (redrawTimer) window.clearTimeout(redrawTimer)
  redrawTimer = window.setTimeout(() => {
    nextTick(drawAllCharts)
  }, 80)
}

const loadReport = async () => {
  loading.value = true
  errorMessage.value = ''

  try {
    const data = await $fetch<ExecutiveApiReport>('/api/reports/executive-investment', {
      query: {
        startDate: selectedStartDate.value,
        endDate: selectedEndDate.value
      }
    })

    executiveApiReport.value = data

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
    report.totals = data.totals
    report.weekly = data.weekly || []
    report.monthly = data.monthly || []
    report.yearly = data.yearly || []
    productItems.value = data.product_items || []
    scheduleChartRedraw()
  } catch (err: any) {
    errorMessage.value = err?.data?.statusMessage || err?.message || 'No se pudo cargar el reporte ejecutivo.'
  } finally {
    loading.value = false
  }
}

watch(selectedSalesMode, () => nextTick(drawSalesChart))

onMounted(() => {
  loadReport()
  window.addEventListener('resize', scheduleChartRedraw)
})

onBeforeUnmount(() => {
  if (redrawTimer) window.clearTimeout(redrawTimer)
  window.removeEventListener('resize', scheduleChartRedraw)
})
</script>

<template>
  <div class="exec-page">
    <section class="top">
      <div>
        <h1>Panel Ejecutivo de Inversión</h1>
        <p>Diseñado para decidir si continuar invirtiendo, ajustar compras o detener expansión.</p>
      </div>
      <div class="period periodControls">
        <label>
          <span>Desde</span>
          <input v-model="selectedStartDate" type="date">
        </label>
        <label>
          <span>Hasta</span>
          <input v-model="selectedEndDate" type="date">
        </label>
        <button type="button" :disabled="loading" @click="loadReport">
          {{ loading ? 'Cargando...' : 'Aplicar' }}
        </button>
        <strong>{{ executiveApiReport?.mode_label || periodCodeLabel || 'Reporte' }}</strong>
      </div>
    </section>

    <section class="decision">
      <div class="decisionMain">
        <div class="bigIcon" :class="`tone-${executiveDecision.tone}`">
          {{ executiveDecision.tone === 'critical' ? '⚠️' : executiveDecision.tone === 'warning' ? '⚠️' : '✓' }}
        </div>
        <div>
          <div class="label">Decisión sugerida</div>
          <h2 :class="`headline-${executiveDecision.tone}`">{{ executiveDecision.label }}</h2>
          <p class="miniText">{{ executiveDecision.copy }}</p>
        </div>
      </div>

      <div class="scoreBox">
        <div class="label">Score de inversión</div>
        <div class="score">{{ investmentScore }}/100</div>
        <div class="bar">
          <i :class="`tone-${executiveDecision.tone}`" :style="{ width: `${investmentScore}%` }" />
        </div>
        <p class="miniText">{{ decisionSentence }}</p>
      </div>

      <div class="scoreRules">
        <div v-for="rule in executiveScoreRules" :key="rule.label" class="rule" :class="rule.tone">
          <span>{{ rule.label }}</span><b>{{ rule.value }}</b>
        </div>
      </div>
    </section>

    <p v-if="errorMessage" class="ui-alert-error">{{ errorMessage }}</p>

    <section class="kpis">
      <div v-for="kpi in executiveDashboardKpis" :key="kpi.key" class="kpi">
        <div class="kpiTop">
          <div>
            <h3>{{ kpi.title }}</h3>
            <strong>{{ loading ? '...' : kpi.value }}</strong>
          </div>
          <div class="ico" :style="{ background: kpi.iconBg }">{{ kpi.icon }}</div>
        </div>
        <div :class="kpi.trendClass">{{ kpi.helper }}</div>
      </div>
    </section>

    <section class="grid2">
      <article class="card">
        <div class="cardHead">
          <div>
            <div class="title"><span class="titleIcon">↗</span>{{ executiveApiReport?.charts.sales.title || 'Evolución de ventas' }}</div>
            <p class="sub">{{ executiveApiReport?.charts.sales.subtitle || 'Tendencia mensual del periodo.' }}</p>
          </div>
          <select v-model="selectedSalesMode" class="select" aria-label="Modo de ventas">
            <option value="ventas">Ventas S/</option>
            <option value="unidades">Unidades</option>
          </select>
        </div>
        <div class="chart">
          <canvas ref="salesChartCanvas" />
        </div>
        <p class="chartInsight">{{ executiveApiReport?.charts.sales.insight || 'Lectura de ventas del periodo seleccionado.' }}</p>
      </article>

      <article class="card">
        <div class="cardHead">
          <div>
            <div class="title"><span class="titleIcon">💧</span>{{ executiveApiReport?.charts.waterfall.title || 'Embudo de rentabilidad' }}</div>
            <p class="sub">{{ executiveApiReport?.charts.waterfall.subtitle || 'De ventas a utilidad neta.' }}</p>
          </div>
        </div>
        <div class="chart">
          <canvas ref="waterfallChartCanvas" />
        </div>
        <p class="chartInsight">{{ executiveApiReport?.charts.waterfall.insight || 'Lectura de rentabilidad del periodo.' }}</p>
      </article>
    </section>

    <section class="grid2">
      <article class="card">
        <div class="cardHead">
          <div>
            <div class="title"><span class="titleIcon">🔁</span>{{ executiveApiReport?.charts.recovery.title || 'Recuperación de compras e inventario' }}</div>
            <p class="sub">{{ executiveApiReport?.charts.recovery.subtitle || 'Compras, ventas, costo vendido y stock restante.' }}</p>
          </div>
        </div>
        <div class="chart">
          <canvas ref="recoveryChartCanvas" />
        </div>
        <p class="chartInsight">{{ executiveApiReport?.charts.recovery.insight || 'Lectura de recuperación de capital.' }}</p>
      </article>

      <article class="card">
        <div class="cardHead">
          <div>
            <div class="title"><span class="titleIcon">🏦</span>{{ executiveApiReport?.charts.cash.title || 'Flujo de caja operativo' }}</div>
            <p class="sub">{{ executiveApiReport?.charts.cash.subtitle || 'Liquidez para sostener inversión.' }}</p>
          </div>
        </div>
        <div class="chart">
          <canvas ref="cashChartCanvas" />
        </div>
        <p class="chartInsight">{{ executiveApiReport?.charts.cash.insight || 'Lectura de caja operativa.' }}</p>
      </article>
    </section>

    <section class="grid2">
      <article class="card">
        <div class="cardHead">
          <div>
            <div class="title"><span class="titleIcon">📈</span>{{ executiveApiReport?.charts.gmroi.title || 'GMROI por categoría' }}</div>
            <p class="sub">{{ executiveApiReport?.charts.gmroi.subtitle || 'Utilidad bruta generada por cada S/1 invertido en stock.' }}</p>
          </div>
        </div>
        <div class="chart">
          <canvas ref="gmroiChartCanvas" />
        </div>
        <div class="gmroiLegend">
          <div class="good">🟢 &gt; 2.0x<br>Invertir</div>
          <div class="mid">🟡 1.0x - 2.0x<br>Revisar</div>
          <div class="low">🔴 &lt; 1.0x<br>No aumentar</div>
        </div>
        <p class="chartInsight">{{ executiveApiReport?.charts.gmroi.insight || 'Lectura de retorno por categoría.' }}</p>
      </article>

      <article class="card">
        <div class="cardHead">
          <div>
            <div class="title"><span class="titleIcon">💸</span>{{ executiveApiReport?.charts.profit.title || 'Dónde gana más' }}</div>
            <p class="sub">{{ executiveApiReport?.charts.profit.subtitle || 'Ganancia bruta por cada S/100 vendidos.' }}</p>
          </div>
        </div>
        <div class="visualProfit">
          <div v-for="bar in profitByCategory" :key="bar.key" class="profitRow">
              <div class="profitName">{{ bar.label }}</div>
              <div class="track">
                <div class="fill" :style="{ width: `${bar.width}%`, background: bar.color }">
                  {{ bar.displayValue }}
                </div>
              </div>
            <div class="pill" :class="bar.value >= 25 ? 'ok' : bar.value >= 15 ? 'warn' : 'bad'">
              {{ bar.status }}
            </div>
          </div>
        </div>
        <p class="chartInsight">{{ executiveApiReport?.charts.profit.insight || 'Lectura de margen por categoría.' }}</p>
      </article>
    </section>

    <section class="grid2">
      <article class="card">
        <div class="cardHead">
          <div>
            <div class="title"><span class="titleIcon">📦</span>{{ executiveApiReport?.charts.inventory.title || 'Inventario y rotación' }}</div>
            <p class="sub">{{ executiveApiReport?.charts.inventory.subtitle || 'Estado del stock por velocidad de venta.' }}</p>
          </div>
        </div>
        <div class="chart">
          <canvas ref="inventoryChartCanvas" />
        </div>
        <p class="chartInsight">{{ executiveApiReport?.charts.inventory.insight || 'Lectura de inventario y rotación.' }}</p>
      </article>

      <article class="card">
        <div class="cardHead">
          <div>
            <div class="title"><span class="titleIcon">⏳</span>{{ executiveApiReport?.charts.aging.title || 'Stock estancado por antigüedad' }}</div>
            <p class="sub">{{ executiveApiReport?.charts.aging.subtitle || 'Dinero inmovilizado según días sin venta.' }}</p>
          </div>
        </div>
        <div class="chart">
          <canvas ref="agingChartCanvas" />
        </div>
        <p class="chartInsight">{{ executiveApiReport?.charts.aging.insight || 'Lectura de antigüedad del stock.' }}</p>
      </article>
    </section>

    <section class="grid2">
      <article class="card">
        <div class="cardHead">
          <div>
            <div class="title"><span class="titleIcon">🚦</span>Semáforo ejecutivo</div>
            <p class="sub">Lectura rápida para dirección.</p>
          </div>
        </div>
        <div class="riskGrid">
          <div v-for="item in executiveRiskItems" :key="item.key" class="risk" :class="item.tone">
            <div class="riskIcon">{{ item.icon }}</div>
            <strong>{{ item.label }}</strong>
            <span>{{ item.value }}</span>
          </div>
        </div>
      </article>

      <article class="card">
        <div class="cardHead">
          <div>
            <div class="title"><span class="titleIcon">🎯</span>Meta del periodo</div>
            <p class="sub">Resultado contra objetivo.</p>
          </div>
        </div>
        <div class="goalBox">
          <div class="goalPct">{{ goalSummary.percentLabel }}</div>
          <div class="bar"><i class="goalFill" :style="{ width: `${goalSummary.percent}%` }" /></div>
          <div class="grid3 compact">
            <div v-for="item in goalSummary.items" :key="item.label" class="risk" :class="item.tone">
              <strong>{{ item.label }}</strong><span>{{ item.value }}</span>
            </div>
          </div>
        </div>
      </article>
    </section>

    <section class="grid3 scenarios">
      <article v-for="scenario in investmentScenarios" :key="scenario.key" class="scenario" :class="{ rec: scenario.recommended }">
        <h3>{{ scenario.title }}</h3>
        <strong>{{ scenario.value }}</strong>
        <p>{{ scenario.copy }}</p>
        <span class="tag" :class="{ recTag: scenario.recommended }">{{ scenario.tag }}</span>
      </article>
    </section>

    <section class="card">
      <div class="cardHead">
          <div>
          <div class="title"><span class="titleIcon">✅</span>Acciones clave</div>
          <p class="sub">Acciones conectadas directamente a la decisión de inversión.</p>
        </div>
      </div>
      <div class="actions">
        <div v-for="(item, index) in actionItems" :key="item.key" class="action">
          <div class="num">{{ index + 1 }}</div>
          <b>{{ item.title }}</b>
          <span>{{ item.copy }}</span>
        </div>
      </div>
      <div class="final">
        {{ executiveApiReport?.conclusion || `Conclusión ejecutiva: ${executiveDecision.copy}` }}
      </div>
      <div class="footerActions">
        <NuxtLink to="/product-profitability" class="ui-btn-secondary">Rentabilidad por producto</NuxtLink>
        <NuxtLink to="/financial-summary" class="ui-btn-secondary">Resumen financiero</NuxtLink>
        <button class="ui-btn-secondary" type="button" :disabled="loading" @click="loadReport">
          {{ loading ? 'Actualizando...' : 'Actualizar' }}
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.exec-page {
  --bg: #f5f7fb;
  --card: #fff;
  --text: #0f172a;
  --muted: #64748b;
  --line: #e2e8f0;
  --blue: #2563eb;
  --blue2: #1e40af;
  --blueSoft: #dbeafe;
  --green: #16a34a;
  --green2: #15803d;
  --greenSoft: #dcfce7;
  --amber: #f59e0b;
  --amber2: #b45309;
  --amberSoft: #fef3c7;
  --red: #dc2626;
  --red2: #991b1b;
  --redSoft: #fee2e2;
  --purple: #7c3aed;
  --purpleSoft: #ede9fe;
  --gray: #94a3b8;
  --shadow: 0 16px 36px rgba(15, 23, 42, 0.08);
  background: var(--bg);
  color: var(--text);
  font-family: Arial, Helvetica, sans-serif;
  margin: -1.5rem;
  min-height: calc(100vh - 4rem);
  padding: 26px 30px 34px;
}

.top {
  align-items: flex-start;
  display: flex;
  gap: 16px;
  justify-content: space-between;
  margin-bottom: 18px;
}

.top h1 {
  color: #06133d;
  font-size: 34px;
  font-weight: 950;
  letter-spacing: -1px;
  line-height: 1.05;
}

.top p {
  color: var(--muted);
  font-size: 14px;
  font-weight: 700;
  margin-top: 4px;
}

.period {
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 14px;
  box-shadow: 0 10px 24px rgba(15, 23, 42, 0.06);
  color: #334155;
  display: flex;
  font-size: 13px;
  font-weight: 900;
  gap: 14px;
  justify-content: space-between;
  min-width: 220px;
  padding: 13px 16px;
}

.periodControls {
  align-items: center;
  display: grid;
  gap: 10px;
  grid-template-columns: auto auto auto auto;
  min-width: 520px;
}

.periodControls label {
  align-items: center;
  display: flex;
  gap: 8px;
}

.periodControls label span {
  color: #64748b;
  font-size: 12px;
  font-weight: 950;
  text-transform: uppercase;
}

.periodControls input {
  background: #f8fafc;
  border: 1px solid var(--line);
  border-radius: 11px;
  color: #334155;
  font-size: 13px;
  font-weight: 900;
  padding: 8px 10px;
}

.periodControls button {
  background: var(--blue);
  border: 0;
  border-radius: 11px;
  color: #fff;
  cursor: pointer;
  font-size: 13px;
  font-weight: 950;
  padding: 9px 13px;
}

.periodControls button:disabled {
  cursor: not-allowed;
  opacity: 0.65;
}

.periodControls strong {
  color: #334155;
  font-size: 13px;
  font-weight: 950;
  text-align: right;
}

.decision {
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 26px;
  box-shadow: var(--shadow);
  display: grid;
  gap: 18px;
  grid-template-columns: 1.05fr 0.75fr 1fr;
  margin-bottom: 14px;
  padding: 22px;
}

.decisionMain {
  align-items: center;
  display: flex;
  gap: 18px;
}

.bigIcon {
  align-items: center;
  border-radius: 26px;
  color: #fff;
  display: grid;
  flex: none;
  font-size: 42px;
  font-weight: 950;
  height: 86px;
  justify-items: center;
  width: 86px;
}

.tone-good,
.bar .tone-good {
  background: linear-gradient(135deg, #16a34a, #22c55e);
}

.tone-warning,
.bar .tone-warning {
  background: linear-gradient(135deg, #f59e0b, #fbbf24);
}

.tone-critical,
.bar .tone-critical {
  background: linear-gradient(135deg, #dc2626, #ef4444);
}

.tone-neutral,
.bar .tone-neutral {
  background: linear-gradient(135deg, #64748b, #94a3b8);
}

.label {
  color: var(--muted);
  font-size: 12px;
  font-weight: 900;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.decision h2 {
  font-size: 28px;
  font-weight: 950;
  letter-spacing: -0.8px;
  margin: 6px 0 8px;
}

.headline-good {
  color: var(--green2);
}

.headline-warning {
  color: var(--amber2);
}

.headline-critical {
  color: var(--red2);
}

.headline-neutral {
  color: #334155;
}

.miniText {
  color: #475569;
  font-size: 14px;
  font-weight: 800;
  line-height: 1.35;
}

.scoreBox {
  align-content: center;
  border-left: 1px solid var(--line);
  border-right: 1px solid var(--line);
  display: grid;
  padding: 0 18px;
}

.score {
  color: #06133d;
  font-size: 40px;
  font-weight: 950;
}

.bar {
  background: #e2e8f0;
  border-radius: 999px;
  height: 12px;
  margin: 8px 0;
  overflow: hidden;
}

.bar i {
  border-radius: 999px;
  display: block;
  height: 100%;
}

.scoreRules {
  align-content: center;
  display: grid;
  gap: 8px;
  grid-template-columns: 1fr 1fr;
}

.rule {
  align-items: center;
  background: #f8fafc;
  border: 1px solid var(--line);
  border-radius: 14px;
  color: #334155;
  display: flex;
  font-size: 12px;
  font-weight: 900;
  gap: 10px;
  justify-content: space-between;
  padding: 10px 11px;
}

.rule.plus b {
  color: var(--green2);
}

.rule.minus b {
  color: var(--red);
}

.kpis {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(7, minmax(130px, 1fr));
  margin-bottom: 12px;
}

.kpi {
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 18px;
  box-shadow: 0 10px 24px rgba(15, 23, 42, 0.06);
  min-height: 120px;
  padding: 15px;
}

.kpiTop {
  align-items: flex-start;
  display: flex;
  gap: 10px;
  justify-content: space-between;
}

.ico {
  align-items: center;
  border-radius: 14px;
  display: grid;
  font-size: 18px;
  height: 38px;
  justify-items: center;
  width: 38px;
}

.kpi h3 {
  color: #475569;
  font-size: 13px;
  font-weight: 900;
  margin-bottom: 5px;
}

.kpi strong {
  color: #06133d;
  display: block;
  font-size: 23px;
  font-weight: 950;
  letter-spacing: -0.6px;
  line-height: 1.05;
}

.trend {
  color: var(--green2);
  font-size: 12px;
  font-weight: 900;
  margin-top: 12px;
}

.trend.red {
  color: var(--red);
}

.trend.warn {
  color: var(--amber2);
}

.grid2,
.grid3 {
  display: grid;
  gap: 12px;
  margin-bottom: 12px;
}

.grid2 {
  grid-template-columns: 1fr 1fr;
}

.grid3 {
  grid-template-columns: 1fr 1fr 1fr;
}

.card {
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 20px;
  box-shadow: 0 10px 24px rgba(15, 23, 42, 0.06);
  padding: 18px;
}

.cardHead {
  align-items: flex-start;
  display: flex;
  gap: 14px;
  justify-content: space-between;
  margin-bottom: 12px;
}

.title {
  align-items: center;
  color: #0f172a;
  display: flex;
  font-size: 18px;
  font-weight: 950;
  gap: 9px;
}

.titleIcon {
  align-items: center;
  background: var(--blue);
  border-radius: 10px;
  color: #fff;
  display: grid;
  font-size: 15px;
  font-weight: 950;
  height: 30px;
  justify-items: center;
  width: 30px;
}

.sub {
  color: var(--muted);
  font-size: 12px;
  font-weight: 700;
  margin-top: 4px;
}

.select {
  background: #f8fafc;
  border: 1px solid var(--line);
  border-radius: 11px;
  color: #334155;
  font-size: 12px;
  font-weight: 900;
  padding: 8px 10px;
}

.chart {
  height: 250px;
  position: relative;
  width: 100%;
}

.chart canvas {
  display: block;
  height: 100%;
  width: 100%;
}

.chartInsight {
  background: #f8fafc;
  border: 1px solid var(--line);
  border-radius: 14px;
  color: #475569;
  font-size: 12px;
  font-weight: 850;
  line-height: 1.35;
  margin-top: 10px;
  padding: 10px 12px;
}

.monthlyChart {
  align-items: end;
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(auto-fit, minmax(52px, 1fr));
  padding-top: 22px;
}

.monthCol {
  align-items: center;
  display: grid;
  gap: 8px;
  grid-template-rows: 28px 1fr 24px;
  height: 250px;
  min-width: 0;
}

.monthCol span {
  color: var(--blue);
  font-size: 11px;
  font-weight: 900;
  text-align: center;
}

.monthTrack {
  align-items: end;
  background: #eef2f7;
  border-radius: 999px;
  display: flex;
  height: 100%;
  overflow: hidden;
  width: 100%;
}

.monthTrack i {
  background: linear-gradient(180deg, #2563eb, #1d4ed8);
  border-radius: 999px;
  display: block;
  width: 100%;
}

.monthCol b {
  color: #64748b;
  font-size: 11px;
  font-weight: 900;
  overflow: hidden;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.horizontalBars {
  align-content: center;
  display: grid;
  gap: 14px;
}

.hRow {
  align-items: center;
  display: grid;
  gap: 12px;
  grid-template-columns: 105px 1fr 92px;
}

.hRow span {
  color: #334155;
  font-size: 12px;
  font-weight: 900;
}

.hTrack {
  background: #eef2f7;
  border-radius: 999px;
  height: 30px;
  overflow: hidden;
}

.hTrack i {
  border-radius: 999px;
  display: block;
  height: 100%;
}

.hRow b {
  color: #0f172a;
  font-size: 12px;
  font-weight: 950;
  text-align: right;
}

.categoryRow {
  grid-template-columns: 105px 1fr 70px 72px;
}

.categoryRow em {
  border-radius: 999px;
  color: #fff;
  font-size: 9px;
  font-style: normal;
  font-weight: 950;
  padding: 6px 7px;
  text-align: center;
}

.gmroiLegend {
  display: grid;
  gap: 8px;
  grid-template-columns: repeat(3, 1fr);
  margin-top: 12px;
}

.gmroiLegend div {
  border-radius: 14px;
  font-size: 12px;
  font-weight: 950;
  padding: 10px;
  text-align: center;
}

.gmroiLegend .good {
  background: var(--greenSoft);
  color: var(--green2);
}

.gmroiLegend .mid {
  background: var(--amberSoft);
  color: var(--amber2);
}

.gmroiLegend .low {
  background: var(--redSoft);
  color: var(--red2);
}

.visualProfit {
  display: grid;
  gap: 10px;
}

.profitRow {
  align-items: center;
  display: grid;
  gap: 12px;
  grid-template-columns: 110px 1fr 88px;
}

.profitName {
  color: #334155;
  font-size: 13px;
  font-weight: 900;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.track {
  background: #eef2f7;
  border-radius: 999px;
  height: 34px;
  overflow: hidden;
}

.fill {
  align-items: center;
  border-radius: 999px;
  color: #fff;
  display: flex;
  font-size: 13px;
  font-weight: 950;
  height: 100%;
  justify-content: flex-end;
  min-width: 42px;
  padding-right: 12px;
}

.pill {
  border-radius: 999px;
  font-size: 12px;
  font-weight: 950;
  padding: 7px 9px;
  text-align: center;
}

.ok {
  background: var(--greenSoft);
  color: var(--green2);
}

.warn {
  background: var(--amberSoft);
  color: var(--amber2);
}

.bad {
  background: var(--redSoft);
  color: var(--red2);
}

.donutWrap {
  align-items: center;
  display: grid;
  gap: 24px;
  grid-template-columns: 0.8fr 1fr;
}

.donut {
  aspect-ratio: 1;
  border-radius: 50%;
  display: grid;
  max-width: 210px;
  place-items: center;
  position: relative;
  width: 100%;
}

.donut::after {
  background: #fff;
  border-radius: 50%;
  content: '';
  inset: 28%;
  position: absolute;
}

.donut div {
  display: grid;
  position: relative;
  text-align: center;
  z-index: 1;
}

.donut strong {
  color: #0f172a;
  font-size: 34px;
  font-weight: 950;
}

.donut span {
  color: var(--muted);
  font-size: 12px;
  font-weight: 900;
}

.donutLegend {
  display: grid;
  gap: 14px;
}

.donutLegend div {
  align-items: center;
  display: grid;
  gap: 10px;
  grid-template-columns: 12px 1fr 42px;
}

.donutLegend i {
  border-radius: 50%;
  height: 12px;
  width: 12px;
}

.donutLegend span,
.donutLegend b {
  color: #334155;
  font-size: 13px;
  font-weight: 900;
}

.riskGrid {
  display: grid;
  gap: 10px;
  grid-template-columns: repeat(3, 1fr);
}

.risk {
  align-content: center;
  border-radius: 18px;
  display: grid;
  gap: 7px;
  min-height: 108px;
  padding: 16px;
  text-align: center;
}

.riskIcon {
  font-size: 27px;
}

.risk strong {
  color: #0f172a;
  font-size: 15px;
  font-weight: 950;
}

.risk span {
  font-size: 12px;
  font-weight: 900;
}

.risk.green {
  background: var(--greenSoft);
}

.risk.amber {
  background: var(--amberSoft);
}

.risk.red {
  background: var(--redSoft);
}

.risk.blue {
  background: var(--blueSoft);
}

.goalBox {
  align-content: center;
  display: grid;
  gap: 14px;
  min-height: 250px;
}

.goalPct {
  color: var(--green2);
  font-size: 52px;
  font-weight: 950;
  letter-spacing: -1px;
}

.goalFill {
  background: linear-gradient(90deg, #2563eb, #16a34a);
}

.compact {
  margin: 0;
}

.scenario {
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 20px;
  box-shadow: 0 10px 24px rgba(15, 23, 42, 0.06);
  display: grid;
  gap: 10px;
  padding: 18px;
}

.scenario.rec {
  background: linear-gradient(180deg, #fff, #f0fdf4);
  border-color: #86efac;
}

.scenario h3 {
  color: #06133d;
  font-size: 18px;
  font-weight: 950;
}

.scenario strong {
  color: #1e40af;
  font-size: 30px;
  font-weight: 950;
}

.scenario p {
  color: var(--muted);
  font-size: 13px;
  font-weight: 750;
  line-height: 1.35;
}

.tag {
  background: #eef2ff;
  border-radius: 999px;
  color: #3730a3;
  font-size: 12px;
  font-weight: 950;
  padding: 7px 10px;
  width: max-content;
}

.recTag {
  background: var(--greenSoft);
  color: var(--green2);
}

.actions {
  display: grid;
  gap: 10px;
  grid-template-columns: repeat(4, 1fr);
}

.action {
  background: #f8fafc;
  border: 1px solid var(--line);
  border-radius: 18px;
  display: grid;
  gap: 8px;
  padding: 15px;
}

.action b {
  color: #06133d;
  font-size: 14px;
  font-weight: 950;
}

.action span {
  color: var(--muted);
  font-size: 12px;
  font-weight: 750;
  line-height: 1.35;
}

.num {
  align-items: center;
  background: var(--blue);
  border-radius: 50%;
  color: #fff;
  display: grid;
  font-weight: 950;
  height: 28px;
  justify-items: center;
  width: 28px;
}

.final {
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  border-radius: 18px;
  color: #1e3a8a;
  font-size: 14px;
  font-weight: 900;
  margin-top: 12px;
  padding: 15px;
}

.footerActions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 14px;
}

@media (max-width: 1300px) {
  .kpis {
    grid-template-columns: repeat(4, 1fr);
  }

  .decision {
    grid-template-columns: 1fr;
  }

  .scoreBox {
    border: 0;
    border-bottom: 1px solid var(--line);
    border-top: 1px solid var(--line);
    padding: 16px 0;
  }

  .grid3,
  .actions {
    grid-template-columns: 1fr 1fr;
  }
}

@media (max-width: 900px) {
  .exec-page {
    margin: -1rem;
    padding: 18px;
  }

  .top,
  .decisionMain {
    align-items: flex-start;
    flex-direction: column;
  }

	  .period {
	    width: 100%;
	  }

  .periodControls {
    grid-template-columns: 1fr;
    min-width: 0;
  }

  .periodControls label {
    align-items: flex-start;
    flex-direction: column;
  }

  .periodControls input,
  .periodControls button {
    width: 100%;
  }

  .kpis,
  .grid2,
  .grid3,
  .actions,
  .riskGrid,
  .scoreRules,
  .donutWrap {
    grid-template-columns: 1fr;
  }

  .profitRow,
  .hRow,
  .categoryRow {
    grid-template-columns: 1fr;
  }

	  .chart {
	    height: 230px;
	  }

  .monthCol {
    height: 230px;
  }
}
</style>
