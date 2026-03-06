import { createError } from 'h3'

import type {
  ProductProfitabilityPeriodCode,
  ProductProfitabilityQuery,
  ProductProfitabilityResult,
  ReportsRepository
} from '../ports'
import { getSupabaseUserClient } from '../../../utils/supabase'

const PAGE_SIZE = 1000
const EPSILON = 0.01
const RECOVERY_START_AT = '2025-01-01T00:00:00.000Z'
const STANDARD_START_AT = '2026-03-09T00:00:00.000Z'

const toNumber = (value: any) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const roundAmount = (value: number) => Number(value.toFixed(2))
const roundQty = (value: number) => Number(value.toFixed(3))
const roundPct = (value: number) => Number(value.toFixed(2))

type MovementAcc = {
  total: number
  qty: number
  last_at: string | null
}

type ProductProfitabilityPeriod = {
  code: ProductProfitabilityPeriodCode
  start_at: string
  end_at_exclusive: string | null
  period_start: string
  period_end: string | null
  adjustments_counted_as_sales: boolean
}

const RECOVERY_PERIOD: ProductProfitabilityPeriod = {
  code: 'recovery_2025_to_2026_03_08',
  start_at: RECOVERY_START_AT,
  end_at_exclusive: STANDARD_START_AT,
  period_start: '2025-01-01',
  period_end: '2026-03-08',
  adjustments_counted_as_sales: true
}

const STANDARD_PERIOD: ProductProfitabilityPeriod = {
  code: 'standard_from_2026_03_09',
  start_at: STANDARD_START_AT,
  end_at_exclusive: null,
  period_start: '2026-03-09',
  period_end: null,
  adjustments_counted_as_sales: false
}

const resolvePeriod = (query?: ProductProfitabilityQuery): ProductProfitabilityPeriod => {
  if (query?.period_code === RECOVERY_PERIOD.code) return RECOVERY_PERIOD
  if (query?.period_code === STANDARD_PERIOD.code) return STANDARD_PERIOD
  const nowMs = Date.now()
  return nowMs < Date.parse(STANDARD_START_AT) ? RECOVERY_PERIOD : STANDARD_PERIOD
}

const isDateInPeriod = (value: any, period: ProductProfitabilityPeriod) => {
  const raw = String(value || '').trim()
  if (!raw) return false
  const ms = Date.parse(raw)
  if (!Number.isFinite(ms)) return false

  const startMs = Date.parse(period.start_at)
  if (ms < startMs) return false

  if (period.end_at_exclusive) {
    const endMs = Date.parse(period.end_at_exclusive)
    if (ms >= endMs) return false
  }

  return true
}

export const makeSupabaseReportsRepository = (accessToken: string): ReportsRepository => {
  const supabase = getSupabaseUserClient(accessToken)

  const fetchAll = async <T>(
    loader: (from: number, to: number) => Promise<{ data: T[] | null; error: any }>
  ): Promise<T[]> => {
    const rows: T[] = []
    let from = 0

    while (true) {
      const to = from + PAGE_SIZE - 1
      const res = await loader(from, to)
      if (res.error) {
        throw createError({ statusCode: 500, statusMessage: res.error.message })
      }

      const batch = (res.data || []) as T[]
      rows.push(...batch)

      if (batch.length < PAGE_SIZE) break
      from += PAGE_SIZE
    }

    return rows
  }

  return {
    async getProductProfitability(query?: ProductProfitabilityQuery): Promise<ProductProfitabilityResult> {
      const period = resolvePeriod(query)
      const [products, purchaseItems, saleItems, adjustmentItems] = await Promise.all([
        fetchAll<any>((from, to) =>
          supabase
            .from('product_catalog')
            .select('id, sku, name, brand, category_name, unit, stock_on_hand, avg_cost, sale_price, active')
            .order('name')
            .order('id')
            .range(from, to)
        ),
        fetchAll<any>((from, to) => {
          let q = supabase
            .from('purchase_items')
            .select('id, product_id, total_cost, qty, created_at')
            .gte('created_at', period.start_at)
            .order('created_at')
            .order('id')

          if (period.end_at_exclusive) {
            q = q.lt('created_at', period.end_at_exclusive)
          }

          return q.range(from, to)
        }),
        fetchAll<any>((from, to) => {
          let q = supabase
            .from('sale_items')
            .select('id, product_id, total, qty, created_at')
            .gte('created_at', period.start_at)
            .order('created_at')
            .order('id')

          if (period.end_at_exclusive) {
            q = q.lt('created_at', period.end_at_exclusive)
          }

          return q.range(from, to)
        }),
        period.adjustments_counted_as_sales
          ? fetchAll<any>((from, to) => {
              let q = supabase
                .from('inventory_count_items')
                .select('id, product_id, delta_qty, applied_at, updated_at, applied')
                .eq('applied', true)
                .gte('applied_at', period.start_at)
                .order('applied_at')
                .order('id')

              if (period.end_at_exclusive) {
                q = q.lt('applied_at', period.end_at_exclusive)
              }

              return q.range(from, to)
            })
          : Promise.resolve([])
      ])

      const purchasesByProduct = new Map<string, MovementAcc>()
      const salesByProduct = new Map<string, MovementAcc>()
      const adjustmentsByProduct = new Map<string, MovementAcc>()

      const salePriceByProduct = new Map<string, number>()
      for (const product of products) {
        const productId = String(product?.id || '').trim()
        if (!productId) continue
        salePriceByProduct.set(productId, toNumber(product?.sale_price))
      }

      for (const row of purchaseItems) {
        const productId = String(row?.product_id || '').trim()
        if (!productId) continue
        if (!isDateInPeriod(row?.created_at, period)) continue

        const current = purchasesByProduct.get(productId) || { total: 0, qty: 0, last_at: null }
        current.total += toNumber(row?.total_cost)
        current.qty += toNumber(row?.qty)

        const rowDate = String(row?.created_at || '').trim()
        if (rowDate && (!current.last_at || rowDate > current.last_at)) {
          current.last_at = rowDate
        }

        purchasesByProduct.set(productId, current)
      }

      for (const row of saleItems) {
        const productId = String(row?.product_id || '').trim()
        if (!productId) continue
        if (!isDateInPeriod(row?.created_at, period)) continue

        const current = salesByProduct.get(productId) || { total: 0, qty: 0, last_at: null }
        current.total += toNumber(row?.total)
        current.qty += toNumber(row?.qty)

        const rowDate = String(row?.created_at || '').trim()
        if (rowDate && (!current.last_at || rowDate > current.last_at)) {
          current.last_at = rowDate
        }

        salesByProduct.set(productId, current)
      }

      for (const row of adjustmentItems) {
        const productId = String(row?.product_id || '').trim()
        if (!productId) continue

        const rowDate = String(row?.applied_at || row?.updated_at || '').trim()
        if (!isDateInPeriod(rowDate, period)) continue

        const deltaQty = toNumber(row?.delta_qty)
        if (deltaQty >= -EPSILON) continue

        const qtyOut = Math.abs(deltaQty)
        const salePrice = toNumber(salePriceByProduct.get(productId) || 0)
        const estimateTotal = qtyOut * salePrice

        const current = adjustmentsByProduct.get(productId) || { total: 0, qty: 0, last_at: null }
        current.total += estimateTotal
        current.qty += qtyOut

        if (rowDate && (!current.last_at || rowDate > current.last_at)) {
          current.last_at = rowDate
        }

        adjustmentsByProduct.set(productId, current)
      }

      const items = products.map((product: any) => {
        const productId = String(product?.id || '').trim()
        const purchaseAcc = purchasesByProduct.get(productId)
        const salesAcc = salesByProduct.get(productId)
        const adjustmentAcc = adjustmentsByProduct.get(productId)

        const purchaseTotal = toNumber(purchaseAcc?.total)
        const purchaseQty = toNumber(purchaseAcc?.qty)
        const salesRecordedTotal = toNumber(salesAcc?.total)
        const salesRecordedQty = toNumber(salesAcc?.qty)
        const salesFromAdjustmentTotal = toNumber(adjustmentAcc?.total)
        const salesFromAdjustmentQty = toNumber(adjustmentAcc?.qty)

        const salesTotal = salesRecordedTotal + salesFromAdjustmentTotal
        const salesQty = salesRecordedQty + salesFromAdjustmentQty
        const balance = salesTotal - purchaseTotal

        const stock = toNumber(product?.stock_on_hand)
        const avgCost = toNumber(product?.avg_cost)
        const inventoryValue = stock * avgCost

        const capitalPending = Math.max(0, purchaseTotal - salesTotal)
        const capitalPendingAfterStock = Math.max(0, purchaseTotal - (salesTotal + inventoryValue))
        const capitalCoveredWithStock = capitalPending > EPSILON && capitalPendingAfterStock <= EPSILON

        let status: 'ganancia' | 'capital_recuperado' | 'perdida' | 'sin_movimiento' = 'sin_movimiento'
        if (purchaseTotal > EPSILON || salesTotal > EPSILON) {
          if (balance > EPSILON) status = 'ganancia'
          else if (Math.abs(balance) <= EPSILON) status = 'capital_recuperado'
          else status = 'perdida'
        }

        const capitalRecoveredPct =
          purchaseTotal > EPSILON ? (salesTotal / purchaseTotal) * 100 : salesTotal > EPSILON ? 100 : 0
        const marginPct = purchaseTotal > EPSILON ? (balance / purchaseTotal) * 100 : null

        return {
          product_id: productId,
          sku: product?.sku ? String(product.sku) : null,
          name: String(product?.name || 'Producto sin nombre'),
          brand: product?.brand ? String(product.brand) : null,
          category_name: product?.category_name ? String(product.category_name) : null,
          unit: String(product?.unit || 'unidad'),
          active: product?.active !== false,
          stock_on_hand: roundQty(stock),
          avg_cost: roundAmount(avgCost),
          purchase_total: roundAmount(purchaseTotal),
          purchase_qty: roundQty(purchaseQty),
          sales_recorded_total: roundAmount(salesRecordedTotal),
          sales_recorded_qty: roundQty(salesRecordedQty),
          sales_from_adjustment_total: roundAmount(salesFromAdjustmentTotal),
          sales_from_adjustment_qty: roundQty(salesFromAdjustmentQty),
          sales_total: roundAmount(salesTotal),
          sales_qty: roundQty(salesQty),
          balance: roundAmount(balance),
          margin_pct: marginPct === null ? null : roundPct(marginPct),
          capital_recovered_pct: roundPct(capitalRecoveredPct),
          inventory_value: roundAmount(inventoryValue),
          capital_pending: roundAmount(capitalPending),
          capital_pending_after_stock: roundAmount(capitalPendingAfterStock),
          capital_covered_with_stock: capitalCoveredWithStock,
          status,
          last_purchase_at: purchaseAcc?.last_at || null,
          last_sale_at: salesAcc?.last_at || null,
          last_adjustment_at: adjustmentAcc?.last_at || null
        }
      })

      const summary = items.reduce(
        (acc, item) => {
          acc.total_products += 1
          if (item.purchase_total > EPSILON) acc.with_purchases += 1
          if (item.sales_total > EPSILON) acc.with_sales += 1
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

      return {
        generated_at: new Date().toISOString(),
        period_code: period.code,
        period_start: period.period_start,
        period_end: period.period_end,
        adjustments_counted_as_sales: period.adjustments_counted_as_sales,
        summary: {
          ...summary,
          purchases_total: roundAmount(summary.purchases_total),
          sales_recorded_total: roundAmount(summary.sales_recorded_total),
          sales_from_adjustment_total: roundAmount(summary.sales_from_adjustment_total),
          sales_total: roundAmount(summary.sales_total),
          balance_total: roundAmount(summary.balance_total),
          inventory_value_total: roundAmount(summary.inventory_value_total)
        },
        items
      }
    }
  }
}
