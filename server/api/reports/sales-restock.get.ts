import { createError, defineEventHandler, getQuery } from 'h3'

import { requireAccessToken } from '../../utils/auth'
import { getSupabaseAdminClient } from '../../utils/supabase'

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

const clampInt = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

const toNumber = (value: unknown) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const round = (value: number, decimals = 2) => {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

const normalizeCategory = (value: unknown) => {
  const raw = String(value || '').trim()
  if (!raw) return 'Sin categoria'
  return raw
}

const resolvePurchaseCost = (product: any) => {
  const lastPurchaseCost = Math.max(0, toNumber(product?.last_purchase_cost))
  if (lastPurchaseCost > 0) return lastPurchaseCost
  return Math.max(0, toNumber(product?.avg_cost))
}

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

const parseDateOnlyUtc = (value: unknown): Date | null => {
  const raw = String(value || '').trim()
  const match = raw.match(DATE_ONLY_RE)
  if (!match) return null

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0))

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null
  }

  return date
}

const formatDateOnlyUtc = (date: Date) => {
  const y = date.getUTCFullYear()
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

const addDaysUtc = (date: Date, days: number) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days, 0, 0, 0, 0))

const PAGE_SIZE = 1000

const fetchAllRows = async <T>(
  fetchPage: (from: number, to: number) => Promise<{ data: T[] | null; error: { message: string } | null }>
) => {
  const rows: T[] = []
  let from = 0

  while (true) {
    const to = from + PAGE_SIZE - 1
    const { data, error } = await fetchPage(from, to)
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    const batch = Array.isArray(data) ? data : []
    rows.push(...batch)
    if (batch.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }

  return rows
}

export default defineEventHandler(async (event) => {
  await requireAccessToken(event)
  const query = getQuery(event)

  const includeAdjustOutAsSales = String(query.include_adjust_out_as_sales || '1') !== '0'
  const maxRows = clampInt(query.limit, 5000, 10, 20000)

  const defaultAsOfDate = '2026-03-09'
  const asOfDate =
    parseDateOnlyUtc(query.as_of_date) ||
    parseDateOnlyUtc(defaultAsOfDate) ||
    addDaysUtc(new Date(), 0)
  const asOfDateLabel = formatDateOnlyUtc(asOfDate)

  // Requisito solicitado: usar ventas del año pasado completo + año actual hasta la fecha de corte.
  const basePeriodStartDate = new Date(Date.UTC(asOfDate.getUTCFullYear() - 1, 0, 1, 0, 0, 0, 0))
  const basePeriodEndExclusiveDate = addDaysUtc(asOfDate, 1)

  const basePeriodStartIso = basePeriodStartDate.toISOString()
  const basePeriodEndExclusiveIso = basePeriodEndExclusiveDate.toISOString()

  const supabase = getSupabaseAdminClient()

  const [catalogRowsRaw, movementRows, purchaseItemRows, saleItemRows] = await Promise.all([
    fetchAllRows<any>((from, to) =>
      supabase
        .from('product_catalog')
        .select('id, sku, name, brand, product_type, unit, stock_on_hand, avg_cost, last_purchase_cost, sale_price, active')
        .order('name')
        .order('id')
        .range(from, to)
    ),
    fetchAllRows<any>((from, to) =>
      supabase
        .from('stock_movements')
        .select('product_id, qty, movement_type, created_at')
        .in('movement_type', ['purchase', 'sale', 'adjust'])
        .gte('created_at', basePeriodStartIso)
        .lt('created_at', basePeriodEndExclusiveIso)
        .order('created_at')
        .order('id')
        .range(from, to)
    ),
    fetchAllRows<any>((from, to) =>
      supabase
        .from('purchase_items')
        .select('product_id, qty, created_at')
        .gte('created_at', basePeriodStartIso)
        .lt('created_at', basePeriodEndExclusiveIso)
        .order('created_at')
        .order('id')
        .range(from, to)
    ),
    fetchAllRows<any>((from, to) =>
      supabase
        .from('sale_items')
        .select('product_id, qty, created_at')
        .gte('created_at', basePeriodStartIso)
        .lt('created_at', basePeriodEndExclusiveIso)
        .order('created_at')
        .order('id')
        .range(from, to)
    )
  ])

  const catalogRows = (Array.isArray(catalogRowsRaw) ? catalogRowsRaw : []).filter(
    (item: any) => item?.active !== false
  )

  const purchasesFromMovements = new Map<string, number>()
  const salesFromMovements = new Map<string, number>()
  const adjustOutByProduct = new Map<string, number>()

  for (const row of movementRows) {
    const productId = String((row as any)?.product_id || '').trim()
    if (!productId) continue

    const movementType = String((row as any)?.movement_type || '').trim().toLowerCase()
    const qtyAbs = Math.abs(toNumber((row as any)?.qty))
    if (qtyAbs <= 0) continue

    if (movementType === 'purchase') {
      purchasesFromMovements.set(productId, (purchasesFromMovements.get(productId) || 0) + qtyAbs)
      continue
    }
    if (movementType === 'sale') {
      salesFromMovements.set(productId, (salesFromMovements.get(productId) || 0) + qtyAbs)
      continue
    }
    if (movementType === 'adjust') {
      const signedQty = toNumber((row as any)?.qty)
      if (signedQty < 0) {
        adjustOutByProduct.set(productId, (adjustOutByProduct.get(productId) || 0) + Math.abs(signedQty))
      }
    }
  }

  const purchasesFromItems = new Map<string, number>()
  for (const row of purchaseItemRows) {
    const productId = String((row as any)?.product_id || '').trim()
    if (!productId) continue

    const qty = Math.abs(toNumber((row as any)?.qty))
    if (qty <= 0) continue
    purchasesFromItems.set(productId, (purchasesFromItems.get(productId) || 0) + qty)
  }

  const salesFromItems = new Map<string, number>()
  for (const row of saleItemRows) {
    const productId = String((row as any)?.product_id || '').trim()
    if (!productId) continue

    const qty = Math.abs(toNumber((row as any)?.qty))
    if (qty <= 0) continue
    salesFromItems.set(productId, (salesFromItems.get(productId) || 0) + qty)
  }

  const suggestions: Suggestion[] = catalogRows
    .map((product: any): Suggestion | null => {
      const productId = String(product?.id || '').trim()
      if (!productId) return null

      const stock = Math.max(0, toNumber(product?.stock_on_hand))
      const purchasesPeriod = Math.max(
        0,
        toNumber(purchasesFromMovements.get(productId) || 0),
        toNumber(purchasesFromItems.get(productId) || 0)
      )
      const salesRecordedPeriod = Math.max(
        0,
        toNumber(salesFromMovements.get(productId) || 0),
        toNumber(salesFromItems.get(productId) || 0)
      )
      const adjustOutPeriod = Math.max(0, toNumber(adjustOutByProduct.get(productId) || 0))
      const salesPeriod = includeAdjustOutAsSales
        ? salesRecordedPeriod + adjustOutPeriod
        : salesRecordedPeriod

      const remainingFromPeriodPurchases = Math.max(0, round(purchasesPeriod - salesPeriod, 3))
      const referenceDemandUnits = Math.max(0, round(salesPeriod, 3))
      const suggestedQty = Math.max(0, Math.ceil(referenceDemandUnits - stock))

      const unitCost = resolvePurchaseCost(product)
      const purchaseCost = round(suggestedQty * unitCost, 2)

      return {
        product_id: productId,
        sku: product?.sku || null,
        name: String(product?.name || 'Producto'),
        brand: product?.brand ? String(product.brand) : null,
        category: normalizeCategory(product?.product_type),
        unit: String(product?.unit || 'unidad'),
        stock_on_hand: round(stock, 3),
        purchases_period_units: round(purchasesPeriod, 3),
        sales_recorded_period_units: round(salesRecordedPeriod, 3),
        adjust_out_period_units: round(adjustOutPeriod, 3),
        sales_period_units: round(salesPeriod, 3),
        remaining_from_period_purchases: round(remainingFromPeriodPurchases, 3),
        reference_demand_units: round(referenceDemandUnits, 3),
        suggested_purchase_qty: suggestedQty,
        is_suggested: suggestedQty > 0,
        estimated_unit_cost: round(unitCost, 4),
        estimated_purchase_cost: purchaseCost
      }
    })
    .filter((row): row is Suggestion => Boolean(row))

  suggestions.sort((a, b) => {
    if (a.is_suggested !== b.is_suggested) {
      return a.is_suggested ? -1 : 1
    }
    if (b.suggested_purchase_qty !== a.suggested_purchase_qty) {
      return b.suggested_purchase_qty - a.suggested_purchase_qty
    }
    if (b.reference_demand_units !== a.reference_demand_units) {
      return b.reference_demand_units - a.reference_demand_units
    }
    return b.estimated_purchase_cost - a.estimated_purchase_cost
  })

  const rows = suggestions.slice(0, maxRows)

  return {
    scenario: {
      generated_at: new Date().toISOString(),
      as_of_date: asOfDateLabel,
      base_period_start: formatDateOnlyUtc(basePeriodStartDate),
      base_period_end_inclusive: asOfDateLabel,
      include_adjust_out_as_sales: includeAdjustOutAsSales
    },
    summary: {
      analyzed_products: catalogRows.length,
      suggested_products: rows.filter((item) => item.is_suggested).length,
      total_buy_units: round(rows.reduce((sum, item) => sum + item.suggested_purchase_qty, 0), 3),
      estimated_investment: round(rows.reduce((sum, item) => sum + item.estimated_purchase_cost, 0), 2)
    },
    suggestions: rows
  }
})
