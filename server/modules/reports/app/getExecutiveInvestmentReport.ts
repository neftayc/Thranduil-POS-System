import { getSupabaseUserClient } from '../../../utils/supabase'

const PAGE_SIZE = 1000
const EPSILON = 0.01
const PERU_OFFSET_MS = 5 * 60 * 60 * 1000
const STANDARD_START_DATE = '2026-03-09'

const COLORS = {
  blue: '#2563eb',
  green: '#16a34a',
  amber: '#f59e0b',
  red: '#dc2626',
  purple: '#7c3aed',
  gray: '#94a3b8'
}

type Tone = 'critical' | 'warning' | 'good' | 'neutral'

type DateRange = {
  startDate: string
  endDate: string
}

type RawProduct = {
  id: string
  name: string | null
  category_name: string | null
  stock_on_hand: number | null
  avg_cost: number | null
  sale_price: number | null
}

type ProductAcc = {
  product_id: string
  name: string
  category_name: string | null
  stock_on_hand: number
  avg_cost: number
  sale_price: number
  purchase_total: number
  purchase_qty: number
  sales_total: number
  sales_qty: number
  sales_cost: number
  adjustment_cost: number
  last_sale_at: string | null
}

type BucketDraft = {
  key: string
  label: string
  start_date: string
  end_date: string
  purchase_items_count: number
  sale_items_count: number
  adjustment_items_count: number
  sales_qty: number
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

const toNumber = (value: any) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const roundAmount = (value: number) => Number(value.toFixed(2))
const roundQty = (value: number) => Number(value.toFixed(3))
const roundPct = (value: number) => Number(value.toFixed(2))
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

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

const formatMoney = (value: number) => moneyFormatter.format(Number(value || 0))
const formatCount = (value: number) => countFormatter.format(Number(value || 0))
const formatPercent = (value: number) => `${roundPct(Number(value || 0))}%`

const pad2 = (value: number) => String(value).padStart(2, '0')

const parseDateKey = (dateKey: string) => {
  const [year, month, day] = String(dateKey || '').split('-').map((part) => Number(part))
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null
  return new Date(Date.UTC(year, month - 1, day))
}

const dateKeyFromDate = (date: Date) =>
  `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`

const getCurrentPeruDateKey = () => dateKeyFromDate(new Date(Date.now() - PERU_OFFSET_MS))

const addDaysToKey = (dateKey: string, days: number) => {
  const date = parseDateKey(dateKey)
  if (!date) return dateKey
  date.setUTCDate(date.getUTCDate() + days)
  return dateKeyFromDate(date)
}

const startOfMonthKey = (dateKey: string) => {
  const date = parseDateKey(dateKey)
  if (!date) return dateKey
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-01`
}

const endOfMonthKey = (dateKey: string) => {
  const date = parseDateKey(dateKey)
  if (!date) return dateKey
  date.setUTCMonth(date.getUTCMonth() + 1)
  date.setUTCDate(0)
  return dateKeyFromDate(date)
}

const addMonthsToKey = (dateKey: string, months: number) => {
  const date = parseDateKey(dateKey)
  if (!date) return dateKey
  date.setUTCMonth(date.getUTCMonth() + months)
  return dateKeyFromDate(date)
}

const toUtcStartIso = (dateKey: string) => {
  const date = parseDateKey(dateKey)
  if (!date) return `${dateKey}T00:00:00.000Z`
  return new Date(date.getTime() + PERU_OFFSET_MS).toISOString()
}

const getPeruDateKeyFromValue = (value: any) => {
  const ms = Date.parse(String(value || ''))
  if (!Number.isFinite(ms)) return null
  return dateKeyFromDate(new Date(ms - PERU_OFFSET_MS))
}

const dateDisplay = (dateKey: string) => {
  const date = parseDateKey(dateKey)
  if (!date) return dateKey
  return `${pad2(date.getUTCDate())}/${pad2(date.getUTCMonth() + 1)}/${date.getUTCFullYear()}`
}

const monthLabel = (dateKey: string) => {
  const months = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'set', 'oct', 'nov', 'dic']
  const date = parseDateKey(dateKey)
  if (!date) return dateKey
  return `${months[date.getUTCMonth()]} ${date.getUTCFullYear()}`
}

const daysBetween = (startDate: string, endDate: string) => {
  const start = parseDateKey(startDate)
  const end = parseDateKey(endDate)
  if (!start || !end) return 1
  return Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000) + 1)
}

const createBucket = (key: string, startDate: string, endDate: string): BucketDraft => ({
  key,
  label: monthLabel(startDate),
  start_date: startDate,
  end_date: endDate,
  purchase_items_count: 0,
  sale_items_count: 0,
  adjustment_items_count: 0,
  sales_qty: 0,
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

const finalizeBucket = (bucket: BucketDraft, granularity: 'monthly' | 'total') => {
  const salesTotal = bucket.sales_recorded_total + bucket.sales_from_adjustment_total
  const costTotal = bucket.sales_cogs_total + bucket.adjustments_cogs_total
  const grossProfit = salesTotal - costTotal
  const marginPct = salesTotal > EPSILON ? (grossProfit / salesTotal) * 100 : 0
  const profitTenPercent = grossProfit * 0.1

  return {
    granularity,
    key: bucket.key,
    label: bucket.label,
    start_date: bucket.start_date,
    end_date: bucket.end_date,
    purchase_items_count: bucket.purchase_items_count,
    sale_items_count: bucket.sale_items_count,
    adjustment_items_count: bucket.adjustment_items_count,
    sales_qty: roundQty(bucket.sales_qty),
    purchases_total: roundAmount(bucket.purchases_total),
    sales_recorded_total: roundAmount(bucket.sales_recorded_total),
    sales_from_adjustment_total: roundAmount(bucket.sales_from_adjustment_total),
    sales_total: roundAmount(salesTotal),
    sales_cogs_total: roundAmount(bucket.sales_cogs_total),
    adjustments_cogs_total: roundAmount(bucket.adjustments_cogs_total),
    gross_profit_total: roundAmount(grossProfit),
    balance_total: roundAmount(salesTotal - bucket.purchases_total),
    margin_pct: roundPct(marginPct),
    profit_ten_percent: roundAmount(profitTenPercent),
    net_after_profit_share: roundAmount(grossProfit - profitTenPercent)
  }
}

const scoreRule = (label: string, ok: boolean, plus: number, minus: number) => ({
  label,
  value: ok ? `+${plus}` : `-${minus}`,
  tone: ok ? 'plus' : 'minus'
})

const getJoinedDate = (row: any, relation: string, field: string) => {
  const value = row?.[relation]
  if (Array.isArray(value)) return String(value[0]?.[field] || '').trim()
  return String(value?.[field] || '').trim()
}

const getDecision = (metrics: {
  salesTotal: number
  grossProfit: number
  netAfterShare: number
  marginPct: number
  gmroi: number
  balance: number
  negativeMonths: number
  slowStockValue: number
  inventoryDays: number | null
}) => {
  const score = Math.round(clamp(
    (metrics.salesTotal > 0 ? 12 : 0) +
    clamp(((metrics.marginPct + 10) / 35) * 24, 0, 24) +
    (metrics.netAfterShare >= 0 ? 18 : 0) +
    clamp(metrics.gmroi * 12, 0, 14) +
    (metrics.grossProfit >= 0 ? 10 : 0) +
    (metrics.slowStockValue <= EPSILON ? 6 : 0) +
    (metrics.inventoryDays !== null && metrics.inventoryDays <= 45 ? 5 : 0) +
    (metrics.balance >= 0 ? 17 : clamp(17 + (metrics.balance / 5000) * 17, 0, 17)),
    0,
    100
  ))

  if (metrics.salesTotal <= EPSILON) {
    return {
      tone: 'neutral' as Tone,
      label: 'Esperar datos',
      title: 'Aún no hay ventas suficientes para decidir inversión.',
      copy: 'El periodo seleccionado no tiene venta registrada. No se recomienda comprar más stock hasta validar demanda.',
      icon: '⚠️',
      score,
      score_text: 'Completar ventas y costo antes de decidir.'
    }
  }

  if (metrics.grossProfit < 0 || metrics.netAfterShare < 0) {
    return {
      tone: 'critical' as Tone,
      label: 'Corregir antes de invertir',
      title: 'No conviene seguir inyectando capital sin corregir precio, costo o merma.',
      copy: 'La operación no cubre el costo real del periodo. La prioridad es recuperar margen, explicar pérdidas y estabilizar caja.',
      icon: '⚠️',
      score,
      score_text: 'No aprobado para nueva inversión.'
    }
  }

  if (metrics.marginPct < 15 || metrics.negativeMonths > 0 || metrics.balance < 0) {
    return {
      tone: 'warning' as Tone,
      label: 'Invertir solo reposición',
      title: 'La operación puede continuar, pero la inversión debe ser selectiva.',
      copy: 'Hay venta, pero el margen o la estabilidad todavía no justifican ampliar inventario de forma general.',
      icon: '⚠️',
      score,
      score_text: 'Aprobado solo con control semanal.'
    }
  }

  return {
    tone: 'good' as Tone,
    label: 'Invertir con ajustes',
    title: 'Hay base para continuar invirtiendo con límites por categoría.',
    copy: 'La inversión debe enfocarse en categorías con buen margen, rotación y recuperación clara de capital.',
    icon: '✓',
    score,
    score_text: 'Aprobado con control semanal.'
  }
}

export const getExecutiveInvestmentReport = async (accessToken: string, range: Partial<DateRange>) => {
  const startDate = range.startDate || STANDARD_START_DATE
  const endDate = range.endDate || getCurrentPeruDateKey()
  const startAt = toUtcStartIso(startDate)
  const endAtExclusive = toUtcStartIso(addDaysToKey(endDate, 1))
  const periodDays = daysBetween(startDate, endDate)
  const supabase = getSupabaseUserClient(accessToken)

  const fetchAll = async <T>(
    loader: (from: number, to: number) => Promise<{ data: T[] | null; error: any }>
  ): Promise<T[]> => {
    const rows: T[] = []
    let from = 0

    while (true) {
      const to = from + PAGE_SIZE - 1
      const res = await loader(from, to)
      if (res.error) throw new Error(res.error.message)
      const batch = (res.data || []) as T[]
      rows.push(...batch)
      if (batch.length < PAGE_SIZE) break
      from += PAGE_SIZE
    }

    return rows
  }

  const [products, purchaseItems, saleItems, saleCostAllocations, saleMovements, adjustmentItems, lastSaleRows] = await Promise.all([
    fetchAll<RawProduct>((from, to) =>
      supabase
        .from('product_catalog')
        .select('id, name, category_name, stock_on_hand, avg_cost, sale_price')
        .order('name')
        .order('id')
        .range(from, to)
    ),
    fetchAll<any>((from, to) =>
      supabase
        .from('purchase_items')
        .select('id, product_id, total_cost, qty, created_at, purchases!inner(purchase_date)')
        .gte('purchases.purchase_date', startAt)
        .lt('purchases.purchase_date', endAtExclusive)
        .order('purchase_date', { referencedTable: 'purchases' })
        .order('id')
        .range(from, to)
    ),
    fetchAll<any>((from, to) =>
      supabase
        .from('sale_items')
        .select('id, sale_id, product_id, total, qty, created_at, sales!inner(sale_date)')
        .gte('sales.sale_date', startAt)
        .lt('sales.sale_date', endAtExclusive)
        .order('sale_date', { referencedTable: 'sales' })
        .order('id')
        .range(from, to)
    ),
    fetchAll<any>((from, to) =>
      supabase
        .from('sale_cost_allocations')
        .select('id, sale_id, product_id, qty, total_cost, created_at, sales!inner(sale_date)')
        .gte('sales.sale_date', startAt)
        .lt('sales.sale_date', endAtExclusive)
        .order('sale_date', { referencedTable: 'sales' })
        .order('id')
        .range(from, to)
    ),
    fetchAll<any>((from, to) =>
      supabase
        .from('stock_movements')
        .select('id, product_id, ref_id, qty, cost_unit, created_at')
        .eq('movement_type', 'sale')
        .gte('created_at', startAt)
        .lt('created_at', endAtExclusive)
        .order('created_at')
        .order('id')
        .range(from, to)
    ),
    fetchAll<any>((from, to) =>
      supabase
        .from('inventory_count_items')
        .select('id, product_id, delta_qty, avg_cost, applied_at, updated_at, applied')
        .eq('applied', true)
        .gte('applied_at', startAt)
        .lt('applied_at', endAtExclusive)
        .order('applied_at')
        .order('id')
        .range(from, to)
    ),
    fetchAll<any>((from, to) =>
      supabase
        .from('sale_items')
        .select('id, product_id, sales!inner(sale_date)')
        .lt('sales.sale_date', endAtExclusive)
        .order('sale_date', { referencedTable: 'sales' })
        .order('id')
        .range(from, to)
    )
  ])

  const productsById = new Map<string, ProductAcc>()
  for (const product of products) {
    const productId = String(product?.id || '').trim()
    if (!productId) continue
    productsById.set(productId, {
      product_id: productId,
      name: String(product?.name || 'Producto sin nombre'),
      category_name: product?.category_name ? String(product.category_name) : null,
      stock_on_hand: toNumber(product?.stock_on_hand),
      avg_cost: toNumber(product?.avg_cost),
      sale_price: toNumber(product?.sale_price),
      purchase_total: 0,
      purchase_qty: 0,
      sales_total: 0,
      sales_qty: 0,
      sales_cost: 0,
      adjustment_cost: 0,
      last_sale_at: null
    })
  }

  for (const row of lastSaleRows) {
    const productId = String(row?.product_id || '').trim()
    const product = productsById.get(productId)
    if (!product) continue
    const saleDate = getJoinedDate(row, 'sales', 'sale_date')
    if (saleDate && (!product.last_sale_at || saleDate > product.last_sale_at)) {
      product.last_sale_at = saleDate
    }
  }

  const monthlyBuckets = new Map<string, BucketDraft>()
  let monthCursor = startOfMonthKey(startDate)
  const lastMonth = startOfMonthKey(endDate)
  while (monthCursor <= lastMonth) {
    monthlyBuckets.set(monthCursor, createBucket(monthCursor, monthCursor, endOfMonthKey(monthCursor)))
    monthCursor = addMonthsToKey(monthCursor, 1)
  }

  const totalBucket = createBucket('total', startDate, endDate)
  totalBucket.label = 'Total'

  const addToBucket = (dateValue: any, apply: (bucket: BucketDraft) => void) => {
    const dateKey = getPeruDateKeyFromValue(dateValue)
    if (!dateKey) return
    const monthKey = startOfMonthKey(dateKey)
    const monthBucket = monthlyBuckets.get(monthKey)
    if (monthBucket) apply(monthBucket)
    apply(totalBucket)
  }

  for (const row of purchaseItems) {
    const productId = String(row?.product_id || '').trim()
    const total = toNumber(row?.total_cost)
    const qty = toNumber(row?.qty)
    const purchaseDate = getJoinedDate(row, 'purchases', 'purchase_date') || row?.created_at
    const product = productsById.get(productId)
    if (product) {
      product.purchase_total += total
      product.purchase_qty += qty
    }
    addToBucket(purchaseDate, (bucket) => {
      bucket.purchase_items_count += 1
      bucket.purchases_total += total
    })
  }

  for (const row of saleItems) {
    const productId = String(row?.product_id || '').trim()
    const total = toNumber(row?.total)
    const qty = toNumber(row?.qty)
    const saleDate = getJoinedDate(row, 'sales', 'sale_date') || row?.created_at
    const product = productsById.get(productId)
    if (product) {
      product.sales_total += total
      product.sales_qty += qty
      const rowDate = String(saleDate || '').trim()
      if (rowDate && (!product.last_sale_at || rowDate > product.last_sale_at)) product.last_sale_at = rowDate
    }
    addToBucket(saleDate, (bucket) => {
      bucket.sale_items_count += 1
      bucket.sales_qty += qty
      bucket.sales_recorded_total += total
    })
  }

  const salesWithAllocatedCost = new Set<string>()
  for (const row of saleCostAllocations) {
    const saleId = String(row?.sale_id || '').trim()
    if (saleId) salesWithAllocatedCost.add(saleId)

    const productId = String(row?.product_id || '').trim()
    const cost = toNumber(row?.total_cost)
    const saleDate = getJoinedDate(row, 'sales', 'sale_date') || row?.created_at
    const product = productsById.get(productId)
    if (product) product.sales_cost += cost
    addToBucket(saleDate, (bucket) => {
      bucket.sales_cogs_total += cost
    })
  }

  for (const row of saleMovements) {
    const saleId = String(row?.ref_id || '').trim()
    if (saleId && salesWithAllocatedCost.has(saleId)) continue

    const productId = String(row?.product_id || '').trim()
    const cost = Math.abs(toNumber(row?.qty)) * toNumber(row?.cost_unit)
    const product = productsById.get(productId)
    if (product) product.sales_cost += cost
    addToBucket(row?.created_at, (bucket) => {
      bucket.sales_cogs_total += cost
    })
  }

  for (const row of adjustmentItems) {
    const deltaQty = toNumber(row?.delta_qty)
    if (deltaQty >= -EPSILON) continue

    const productId = String(row?.product_id || '').trim()
    const rowDate = row?.applied_at || row?.updated_at
    const rowDateKey = getPeruDateKeyFromValue(rowDate)
    if (!rowDateKey || rowDateKey >= STANDARD_START_DATE) continue

    const product = productsById.get(productId)
    const cost = Math.abs(deltaQty) * toNumber(row?.avg_cost)
    const qtyOut = Math.abs(deltaQty)
    const estimateTotal = qtyOut * toNumber(product?.sale_price || 0)

    if (product) product.adjustment_cost += cost
    if (product) {
      product.sales_total += estimateTotal
      product.sales_qty += qtyOut
    }
    addToBucket(rowDate, (bucket) => {
      bucket.adjustment_items_count += 1
      bucket.sales_qty += qtyOut
      bucket.sales_from_adjustment_total += estimateTotal
      bucket.adjustments_cogs_total += cost
    })
  }

  const monthly = Array.from(monthlyBuckets.values()).map((bucket) => finalizeBucket(bucket, 'monthly'))
  const totals = finalizeBucket(totalBucket, 'total')
  const productItems = Array.from(productsById.values()).map((product) => {
    const inventoryValue = product.stock_on_hand * product.avg_cost
    const profit = product.sales_total - product.sales_cost - product.adjustment_cost
    return {
      product_id: product.product_id,
      name: product.name,
      category_name: product.category_name,
      stock_on_hand: roundQty(product.stock_on_hand),
      sales_total: roundAmount(product.sales_total),
      sales_qty: roundQty(product.sales_qty),
      purchase_total: roundAmount(product.purchase_total),
      margin_pct: product.sales_total > EPSILON ? roundPct((profit / product.sales_total) * 100) : null,
      inventory_value: roundAmount(inventoryValue),
      last_sale_at: product.last_sale_at,
      status: profit > EPSILON ? 'ganancia' : profit < -EPSILON ? 'perdida' : 'sin_movimiento'
    }
  })

  const inventoryValue = productItems.reduce((sum, item) => sum + item.inventory_value, 0)
  const grossProfit = totals.gross_profit_total
  const totalCost = totals.sales_cogs_total + totals.adjustments_cogs_total
  const gmroi = inventoryValue > EPSILON ? grossProfit / inventoryValue : 0
  const sellThrough = totals.purchases_total > EPSILON ? (totals.sales_total / totals.purchases_total) * 100 : 0
  const inventoryDays = totalCost > EPSILON && inventoryValue > EPSILON
    ? Math.round((inventoryValue / totalCost) * periodDays)
    : null

  const slowStockValue = productItems
    .filter((item) => item.stock_on_hand > EPSILON && (!item.last_sale_at || daysBetween(getPeruDateKeyFromValue(item.last_sale_at) || startDate, endDate) > 60))
    .reduce((sum, item) => sum + item.inventory_value, 0)

  const negativeMonths = monthly.filter((bucket) => bucket.gross_profit_total < 0).length
  const decision = getDecision({
    salesTotal: totals.sales_total,
    grossProfit,
    netAfterShare: totals.net_after_profit_share,
    marginPct: totals.margin_pct,
    gmroi,
    balance: totals.balance_total,
    negativeMonths,
    slowStockValue,
    inventoryDays
  })

  const categoryMap = new Map<string, { sales: number; profit: number; inventory: number }>()
  for (const product of productsById.values()) {
    const label = product.category_name || 'Sin categoría'
    const current = categoryMap.get(label) || { sales: 0, profit: 0, inventory: 0 }
    current.sales += product.sales_total
    current.profit += product.sales_total - product.sales_cost - product.adjustment_cost
    current.inventory += product.stock_on_hand * product.avg_cost
    categoryMap.set(label, current)
  }

  const categoryRows = Array.from(categoryMap.entries())
    .map(([label, value]) => ({
      label,
      sales: value.sales,
      profit: value.profit,
      inventory: value.inventory,
      gmroi: value.inventory > EPSILON ? value.profit / value.inventory : 0,
      profitPer100: value.sales > EPSILON ? (value.profit / value.sales) * 100 : 0
    }))
    .sort((a, b) => b.sales - a.sales)

  const gmroiRows = categoryRows
    .slice()
    .sort((a, b) => b.gmroi - a.gmroi)
    .slice(0, 5)
    .map((row) => ({
      label: row.label,
      value: roundPct(row.gmroi),
      displayValue: `${roundPct(row.gmroi)}x`,
      color: row.gmroi >= 2 ? COLORS.green : row.gmroi >= 1 ? COLORS.amber : COLORS.red,
      status: row.gmroi >= 2 ? 'Invertir' : row.gmroi >= 1 ? 'Revisar' : 'No aumentar'
    }))

  const profitRows = categoryRows
    .slice()
    .sort((a, b) => b.profitPer100 - a.profitPer100)
    .slice(0, 5)
    .map((row) => ({
      label: row.label,
      value: roundPct(row.profitPer100),
      displayValue: formatMoney(row.profitPer100),
      color: row.profitPer100 >= 25 ? COLORS.green : row.profitPer100 >= 15 ? COLORS.amber : COLORS.red,
      status: row.profitPer100 >= 25 ? 'Comprar' : row.profitPer100 >= 15 ? 'Revisar' : 'Corregir'
    }))

  const stockWithSales = productItems.filter((item) => item.sales_total > EPSILON && item.stock_on_hand > EPSILON).length
  const soldOut = productItems.filter((item) => item.sales_total > EPSILON && item.stock_on_hand <= EPSILON).length
  const stockWithoutSales = productItems.filter((item) => item.sales_total <= EPSILON && item.stock_on_hand > EPSILON).length
  const totalProducts = Math.max(productItems.length, 1)

  const inventoryMix = [
    { label: 'Alta rotación', value: Math.round((stockWithSales / totalProducts) * 100), color: COLORS.green },
    { label: 'Media', value: Math.round((soldOut / totalProducts) * 100), color: COLORS.amber },
    { label: 'Baja', value: Math.round((stockWithoutSales / totalProducts) * 100), color: COLORS.red },
    { label: 'Estancado', value: Math.max(0, 100 - Math.round(((stockWithSales + soldOut + stockWithoutSales) / totalProducts) * 100)), color: COLORS.gray }
  ]

  const agingRows = [
    { key: '0_30', label: '0-30 días', value: 0, color: COLORS.green },
    { key: '31_60', label: '31-60 días', value: 0, color: COLORS.amber },
    { key: '61_90', label: '61-90 días', value: 0, color: COLORS.amber },
    { key: '90_plus', label: '+90 días', value: 0, color: COLORS.red }
  ]

  for (const item of productItems) {
    if (item.stock_on_hand <= EPSILON) continue
    const lastSale = item.last_sale_at ? getPeruDateKeyFromValue(item.last_sale_at) : null
    const days = lastSale ? daysBetween(lastSale, endDate) : 999
    if (days > 90) agingRows[3].value += item.inventory_value
    else if (days > 60) agingRows[2].value += item.inventory_value
    else if (days > 30) agingRows[1].value += item.inventory_value
    else agingRows[0].value += item.inventory_value
  }

  const breakEvenGap = Math.max(0, totalCost - totals.sales_total)
  const margin15Gap = totalCost > EPSILON ? Math.max(0, totalCost / 0.85 - totals.sales_total) : 0
  const margin25Gap = totalCost > EPSILON ? Math.max(0, totalCost / 0.75 - totals.sales_total) : 0
  const costCut15 = Math.max(0, totalCost - totals.sales_total * 0.85)
  const goalPercent = breakEvenGap <= EPSILON ? 100 : clamp((totals.sales_total / Math.max(totalCost, 1)) * 100, 0, 100)

  return {
    generated_at: new Date().toISOString(),
    period_code: startDate < STANDARD_START_DATE ? 'recovery_2025_to_2026_03_08' : 'standard_from_2026_03_09',
    period_start: startDate,
    period_end: endDate,
    period_label: `${dateDisplay(startDate)} - ${dateDisplay(endDate)}`,
    mode_label: startDate >= STANDARD_START_DATE ? 'Operación normal' : 'Periodo personalizado',
    adjustments_counted_as_sales: startDate < STANDARD_START_DATE,
    decision,
    conclusion: `Conclusión ejecutiva: ${decision.copy}`,
    score_rules: [
      scoreRule('Ventas', totals.sales_total > EPSILON, 12, 12),
      scoreRule('Margen', totals.margin_pct >= 15, 16, 16),
      scoreRule('Utilidad neta', totals.net_after_profit_share >= 0, 18, 18),
      scoreRule('GMROI', gmroi >= 1, 14, 14),
      scoreRule('Meta', breakEvenGap <= EPSILON, 10, 10),
      scoreRule('Stock lento', slowStockValue <= EPSILON, 6, 6),
      scoreRule('Días inv.', inventoryDays !== null && inventoryDays <= 45, 5, 5),
      scoreRule('Caja', totals.balance_total >= 0, 17, 17)
    ],
    kpis: [
      {
        key: 'sales',
        title: 'Ventas',
        value: formatMoney(totals.sales_total),
        icon: '💰',
        iconBg: '#dbeafe',
        helper: totals.sales_total > EPSILON ? 'Ingreso registrado' : 'Sin venta',
        trendClass: totals.sales_total > EPSILON ? 'trend' : 'trend red'
      },
      {
        key: 'net',
        title: 'Utilidad neta',
        value: formatMoney(totals.net_after_profit_share),
        icon: '✅',
        iconBg: '#dcfce7',
        helper: totals.net_after_profit_share >= 0 ? 'Neta después del 10%' : 'Negativa',
        trendClass: totals.net_after_profit_share >= 0 ? 'trend' : 'trend red'
      },
      {
        key: 'gmroi',
        title: 'GMROI',
        value: inventoryValue > EPSILON ? `${roundPct(gmroi)}x` : 'S/D',
        icon: '📈',
        iconBg: '#ede9fe',
        helper: inventoryValue > EPSILON ? 'Utilidad bruta / inventario' : 'Falta inventario valorizado',
        trendClass: gmroi >= 2 ? 'trend' : gmroi >= 1 ? 'trend warn' : 'trend red'
      },
      {
        key: 'sellthrough',
        title: 'Sell-through',
        value: formatPercent(sellThrough),
        icon: '🔁',
        iconBg: '#dcfce7',
        helper: sellThrough >= 80 ? 'Bueno' : 'Bajo',
        trendClass: sellThrough >= 80 ? 'trend' : 'trend warn'
      },
      {
        key: 'inventory_days',
        title: 'Días inventario',
        value: inventoryDays === null ? 'S/D' : `${formatCount(inventoryDays)} días`,
        icon: '📦',
        iconBg: '#ffedd5',
        helper: inventoryDays === null ? 'Sin base' : inventoryDays <= 45 ? 'Meta 30-45' : 'Sobre meta',
        trendClass: inventoryDays !== null && inventoryDays <= 45 ? 'trend' : 'trend warn'
      },
      {
        key: 'cash',
        title: 'Caja neta',
        value: formatMoney(totals.balance_total),
        icon: '🏦',
        iconBg: '#ccfbf1',
        helper: totals.balance_total >= 0 ? 'Positiva' : 'Presión de caja',
        trendClass: totals.balance_total >= 0 ? 'trend' : 'trend red'
      },
      {
        key: 'slow_stock',
        title: 'Stock lento',
        value: formatMoney(slowStockValue),
        icon: '⚠️',
        iconBg: '#fee2e2',
        helper: slowStockValue > EPSILON ? 'Capital inmovilizado' : 'Sin alerta',
        trendClass: slowStockValue > EPSILON ? 'trend red' : 'trend'
      }
    ],
    charts: {
      sales: {
        title: 'Evolución de ventas',
        subtitle: 'Tendencia mensual del periodo.',
        insight: monthly.length
          ? `Mayor venta: ${monthly.slice().sort((a, b) => b.sales_total - a.sales_total)[0]?.label || 'sin dato'}.`
          : 'Sin meses visibles en el periodo.',
        labels: monthly.map((bucket) => bucket.label),
        ventas: monthly.map((bucket) => bucket.sales_total),
        unidades: monthly.map((bucket) => bucket.sales_qty)
      },
      waterfall: {
        title: 'Embudo de rentabilidad',
        subtitle: 'De ventas a utilidad neta.',
        insight: grossProfit >= 0
          ? `El periodo conserva ${formatMoney(grossProfit)} de utilidad bruta antes del 10%.`
          : `El costo supera a la venta por ${formatMoney(Math.abs(grossProfit))}.`,
        items: [
          { label: 'Ventas', value: totals.sales_total, displayValue: formatMoney(totals.sales_total), color: COLORS.blue },
          { label: 'Costo', value: totalCost, displayValue: formatMoney(totalCost), color: COLORS.red },
          { label: 'Util. bruta', value: grossProfit, displayValue: formatMoney(grossProfit), color: grossProfit >= 0 ? COLORS.green : COLORS.red },
          { label: '10%', value: totals.profit_ten_percent, displayValue: formatMoney(totals.profit_ten_percent), color: COLORS.amber },
          { label: 'Neto', value: totals.net_after_profit_share, displayValue: formatMoney(totals.net_after_profit_share), color: totals.net_after_profit_share >= 0 ? COLORS.green : COLORS.red }
        ]
      },
      recovery: {
        title: 'Recuperación de compras e inventario',
        subtitle: 'Compras, ventas, costo vendido y stock restante.',
        insight: totals.balance_total >= 0
          ? `La venta cubre compras y deja ${formatMoney(totals.balance_total)} de balance.`
          : `Falta ${formatMoney(Math.abs(totals.balance_total))} para cubrir compras del periodo.`,
        items: [
          { label: 'Compras', value: totals.purchases_total, displayValue: formatMoney(totals.purchases_total), color: COLORS.blue },
          { label: 'Ventas', value: totals.sales_total, displayValue: formatMoney(totals.sales_total), color: COLORS.green },
          { label: 'Costo vend.', value: totalCost, displayValue: formatMoney(totalCost), color: COLORS.red },
          { label: 'Stock', value: inventoryValue, displayValue: formatMoney(inventoryValue), color: COLORS.amber },
          { label: 'Estanc.', value: slowStockValue, displayValue: formatMoney(slowStockValue), color: COLORS.red }
        ]
      },
      cash: {
        title: 'Flujo de caja operativo',
        subtitle: 'Liquidez para sostener inversión.',
        insight: totals.balance_total >= 0 ? 'La caja operativa no está presionada por compras.' : 'La caja requiere recuperación antes de ampliar stock.',
        items: [
          { label: 'Cobros', value: totals.sales_total, displayValue: formatMoney(totals.sales_total), color: COLORS.green },
          { label: 'Proveedores', value: totals.purchases_total, displayValue: formatMoney(totals.purchases_total), color: COLORS.red },
          { label: '10%', value: totals.profit_ten_percent, displayValue: formatMoney(totals.profit_ten_percent), color: COLORS.amber },
          { label: 'Caja neta', value: totals.balance_total, displayValue: formatMoney(totals.balance_total), color: totals.balance_total >= 0 ? COLORS.blue : COLORS.red }
        ]
      },
      gmroi: {
        title: 'GMROI por categoría',
        subtitle: 'Utilidad bruta generada por cada S/1 invertido en stock.',
        insight: gmroiRows[0] ? `${gmroiRows[0].label} es la categoría con mejor retorno sobre inventario.` : 'No hay categoría con retorno medible.',
        items: gmroiRows
      },
      profit: {
        title: 'Dónde gana más',
        subtitle: 'Ganancia bruta por cada S/100 vendidos.',
        insight: profitRows[0] ? `${profitRows[0].label} deja ${profitRows[0].displayValue} por cada S/100 vendidos.` : 'No hay categorías con venta suficiente.',
        items: profitRows
      },
      inventory: {
        title: 'Inventario y rotación',
        subtitle: 'Estado del stock por velocidad de venta.',
        insight: slowStockValue > EPSILON ? `${formatMoney(slowStockValue)} están inmovilizados o sin venta reciente.` : 'No hay alerta relevante de stock lento.',
        items: inventoryMix,
        centerValue: inventoryValue > EPSILON ? roundPct(gmroi).toString() : 'S/D',
        centerLabel: 'veces'
      },
      aging: {
        title: 'Stock estancado por antigüedad',
        subtitle: 'Dinero inmovilizado según días sin venta.',
        insight: agingRows[3].value > EPSILON ? `${formatMoney(agingRows[3].value)} superan 90 días sin venta.` : 'El stock no muestra antigüedad crítica.',
        items: agingRows.map((row) => ({ ...row, displayValue: formatMoney(row.value) }))
      }
    },
    risk_items: [
      { key: 'sales', label: 'Ventas', value: totals.sales_total > EPSILON ? 'Activas' : 'Sin venta', tone: totals.sales_total > EPSILON ? 'green' : 'red', icon: totals.sales_total > EPSILON ? '🟢' : '🔴' },
      { key: 'profit', label: 'Utilidad', value: grossProfit >= 0 ? 'Positiva' : 'Negativa', tone: grossProfit >= 0 ? 'green' : 'red', icon: grossProfit >= 0 ? '🟢' : '🔴' },
      { key: 'gmroi', label: 'GMROI', value: inventoryValue > EPSILON ? `${roundPct(gmroi)}x` : 'S/D', tone: gmroi >= 2 ? 'green' : gmroi >= 1 ? 'amber' : 'red', icon: gmroi >= 2 ? '🟢' : gmroi >= 1 ? '🟡' : '🔴' },
      { key: 'sellthrough', label: 'Sell-through', value: formatPercent(sellThrough), tone: sellThrough >= 80 ? 'green' : 'amber', icon: sellThrough >= 80 ? '🟢' : '🟡' },
      { key: 'inventory', label: 'Inventario', value: inventoryDays === null ? 'S/D' : `${formatCount(inventoryDays)} días`, tone: inventoryDays !== null && inventoryDays <= 45 ? 'green' : 'amber', icon: inventoryDays !== null && inventoryDays <= 45 ? '🟢' : '🟡' },
      { key: 'slow_stock', label: 'Stock lento', value: slowStockValue > EPSILON ? formatMoney(slowStockValue) : 'Sin alerta', tone: slowStockValue > EPSILON ? 'red' : 'green', icon: slowStockValue > EPSILON ? '🔴' : '🟢' }
    ],
    goal: {
      percent: roundPct(goalPercent),
      percentLabel: breakEvenGap <= EPSILON ? '100%' : formatPercent(goalPercent),
      items: [
        { label: 'Ventas', value: formatMoney(totals.sales_total), tone: 'blue' },
        { label: 'Costo', value: formatMoney(totalCost), tone: 'amber' },
        { label: 'Brecha', value: formatMoney(breakEvenGap), tone: breakEvenGap <= EPSILON ? 'green' : 'red' }
      ]
    },
    scenarios: [
      {
        key: 'conservative',
        title: 'Conservador',
        value: formatMoney(breakEvenGap),
        copy: 'Solo recuperar equilibrio y sostener operación.',
        tag: 'Mantener operación',
        recommended: false
      },
      {
        key: 'recommended',
        title: 'Recomendado',
        value: decision.tone === 'critical' ? 'S/ 0.00' : formatMoney(Math.max(0, totals.net_after_profit_share)),
        copy: 'Invertir solo en productos rentables y de rotación comprobada.',
        tag: 'Mejor equilibrio',
        recommended: true
      },
      {
        key: 'aggressive',
        title: 'Agresivo',
        value: decision.tone === 'good' ? formatMoney(Math.max(0, totals.net_after_profit_share * 2)) : 'No recomendado',
        copy: 'Requiere caja positiva, GMROI sano y meses sin pérdida.',
        tag: 'Mayor riesgo',
        recommended: false
      }
    ],
    actions: [
      ...(grossProfit < 0 ? [{ key: 'loss', title: 'Congelar compras no críticas', copy: 'Comprar solo reposición de productos con venta comprobada hasta cubrir la pérdida bruta.', tone: 'critical' as Tone }] : []),
      ...(totals.margin_pct < 15 ? [{ key: 'price', title: 'Revisar precio y costo de reposición', copy: 'La brecha de margen exige subir precio, bajar costo o reducir merma antes de ampliar inventario.', tone: 'warning' as Tone }] : []),
      ...(negativeMonths > 0 ? [{ key: 'months', title: 'Aislar meses negativos', copy: 'Cruzar meses en alerta con productos, ajustes de inventario y compras para encontrar el origen.', tone: 'warning' as Tone }] : []),
      { key: 'inventory', title: 'Completar control por categoría', copy: 'Usar GMROI, sell-through y antigüedad de stock para decidir compras por categoría, no por intuición.', tone: 'neutral' as Tone }
    ].slice(0, 4),
    scenario_cards: [
      {
        key: 'break_even',
        label: 'Punto de equilibrio',
        value: breakEvenGap > EPSILON ? formatMoney(breakEvenGap) : 'Cubierto',
        helper: breakEvenGap > EPSILON ? 'Venta adicional estimada para cubrir el costo ya registrado.' : 'Las ventas ya cubren el costo real registrado.',
        tone: breakEvenGap > EPSILON ? 'critical' : 'good'
      },
      {
        key: 'target_15',
        label: 'Brecha a margen 15%',
        value: margin15Gap > EPSILON ? formatMoney(margin15Gap) : 'Cumplido',
        helper: 'Venta adicional necesaria si el costo real se mantiene.',
        tone: margin15Gap > EPSILON ? 'warning' : 'good'
      },
      {
        key: 'target_25',
        label: 'Brecha a margen 25%',
        value: margin25Gap > EPSILON ? formatMoney(margin25Gap) : 'Cumplido',
        helper: 'Referencia para una operación más sana antes de escalar stock.',
        tone: margin25Gap > EPSILON ? 'warning' : 'good'
      },
      {
        key: 'cost_cut',
        label: 'Ajuste de costo para 15%',
        value: costCut15 > EPSILON ? formatMoney(costCut15) : 'Sin recorte',
        helper: 'Reducción de costo/merma requerida si no crece la venta.',
        tone: costCut15 > EPSILON ? 'warning' : 'good'
      }
    ],
    totals,
    weekly: [],
    monthly,
    yearly: [],
    product_items: productItems
  }
}
