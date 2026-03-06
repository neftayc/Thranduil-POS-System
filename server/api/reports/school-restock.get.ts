import { createError, defineEventHandler, getQuery } from 'h3'

import { requireAccessToken } from '../../utils/auth'
import { getSupabaseAdminClient } from '../../utils/supabase'

type PriorityLevel = 'critica' | 'alta' | 'media' | 'baja'

type AgentSignals = {
  stock_risk_score: number
  campaign_pressure_score: number
  velocity_score: number
  margin_score: number
}

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
  agents: AgentSignals
}

const clampInt = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

const clampNumber = (
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  decimals = 2
) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  const bounded = Math.min(max, Math.max(min, parsed))
  const factor = 10 ** decimals
  return Math.round(bounded * factor) / factor
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

const resolvePriority = (stock: number, minRequiredUnits: number): PriorityLevel => {
  if (stock <= 0) return 'critica'
  if (stock < minRequiredUnits * 0.5) return 'alta'
  return 'media'
}

const buildPriorityScore = (stock: number, minRequiredUnits: number) => {
  if (minRequiredUnits <= 0) return 0
  const gap = Math.max(0, minRequiredUnits - stock)
  return round(Math.min(100, (gap / minRequiredUnits) * 100), 2)
}

const buildFallbackNarrative = (
  summary: {
    suggested_products: number
    stockouts_now: number
    total_buy_units: number
    estimated_investment: number
  },
  minRequiredUnits: number
) => {
  return [
    `Alerta inmediata con mínimo global de ${minRequiredUnits} unidades por producto.`,
    `${summary.suggested_products} productos están por debajo del umbral.`,
    `Sin stock: ${summary.stockouts_now}.`,
    `Compra sugerida: ${summary.total_buy_units} unidades con inversión estimada S/ ${summary.estimated_investment.toFixed(2)}.`
  ].join(' ')
}

export default defineEventHandler(async (event) => {
  await requireAccessToken(event)
  const query = getQuery(event)

  const minRequiredUnits = clampInt(query.min_required_units, 12, 1, 5000)
  const maxRows = clampInt(query.limit, 5000, 10, 20000)
  const fallbackCostFactor = clampNumber(query.fallback_cost_factor, 0.62, 0.3, 1, 2)

  const supabase = getSupabaseAdminClient()
  const catalogRes = await supabase
    .from('product_catalog')
    .select('id, sku, name, product_type, brand, unit, sale_price, stock_on_hand, avg_cost, last_purchase_cost, min_stock, active')

  if (catalogRes.error) {
    throw createError({ statusCode: 500, statusMessage: catalogRes.error.message })
  }

  const catalogRows = (Array.isArray(catalogRes.data) ? catalogRes.data : []).filter(
    (item: any) => item?.active !== false
  )

  const recommendations: RestockRecommendation[] = catalogRows
    .map((product: any): RestockRecommendation | null => {
      const stock = Math.max(0, toNumber(product.stock_on_hand))
      if (stock >= minRequiredUnits) return null

      const salePrice = Math.max(0, toNumber(product.sale_price))
      const avgCost = Math.max(0, toNumber(product.avg_cost))
      const suggestedPurchaseQty = Math.max(1, Math.ceil(minRequiredUnits - stock))
      const estimatedUnitCost = resolvePurchaseCost(product)
      const estimatedPurchaseCost = round(suggestedPurchaseQty * estimatedUnitCost, 2)
      const expectedRevenue = round(suggestedPurchaseQty * salePrice, 2)
      const potentialGrossMargin = round(expectedRevenue - estimatedPurchaseCost, 2)
      const priority = resolvePriority(stock, minRequiredUnits)
      const priorityScore = buildPriorityScore(stock, minRequiredUnits)

      const reasons = [
        stock <= 0
          ? `Sin stock. Debe llegar al mínimo de ${minRequiredUnits} u.`
          : `Stock actual ${round(stock, 3)} u. por debajo del mínimo de ${minRequiredUnits} u.`
      ]

      return {
        product_id: String(product.id || ''),
        sku: product.sku || null,
        name: String(product.name || 'Producto'),
        category: normalizeCategory(product.product_type),
        brand: product.brand || null,
        unit: String(product.unit || 'unidad'),
        stock_on_hand: round(stock, 3),
        min_stock: round(Math.max(0, toNumber(product.min_stock)), 3),
        avg_cost: round(avgCost, 4),
        sale_price: round(salePrice, 2),
        school_lists_count: 0,
        school_units_per_set: 0,
        campaign_demand_units: 0,
        recent_sales_units: 0,
        avg_daily_sales: 0,
        velocity_demand_units: 0,
        safety_stock_units: minRequiredUnits,
        target_stock_units: minRequiredUnits,
        suggested_purchase_qty: suggestedPurchaseQty,
        estimated_unit_cost: round(estimatedUnitCost, 4),
        estimated_purchase_cost: estimatedPurchaseCost,
        expected_revenue: expectedRevenue,
        potential_gross_margin: potentialGrossMargin,
        coverage_days: null,
        priority,
        priority_score: priorityScore,
        reasons,
        agents: {
          stock_risk_score: priorityScore,
          campaign_pressure_score: 0,
          velocity_score: 0,
          margin_score: 0
        }
      }
    })
    .filter((row): row is RestockRecommendation => Boolean(row))

  recommendations.sort((a, b) => {
    if (a.stock_on_hand !== b.stock_on_hand) return a.stock_on_hand - b.stock_on_hand
    if (b.suggested_purchase_qty !== a.suggested_purchase_qty) {
      return b.suggested_purchase_qty - a.suggested_purchase_qty
    }
    return b.estimated_purchase_cost - a.estimated_purchase_cost
  })

  const rows = recommendations.slice(0, maxRows)

  const totalBuyUnits = rows.reduce((sum, item) => sum + item.suggested_purchase_qty, 0)
  const estimatedInvestment = round(rows.reduce((sum, item) => sum + item.estimated_purchase_cost, 0), 2)
  const expectedRevenue = round(rows.reduce((sum, item) => sum + item.expected_revenue, 0), 2)
  const expectedMargin = round(rows.reduce((sum, item) => sum + item.potential_gross_margin, 0), 2)

  const summary = {
    analyzed_products: catalogRows.length,
    products_linked_to_lists: 0,
    suggested_products: rows.length,
    critical_count: rows.filter((item) => item.priority === 'critica').length,
    high_count: rows.filter((item) => item.priority === 'alta').length,
    medium_count: rows.filter((item) => item.priority === 'media').length,
    low_count: rows.filter((item) => item.priority === 'baja').length,
    stockouts_now: rows.filter((item) => item.stock_on_hand <= 0).length,
    total_buy_units: round(totalBuyUnits, 3),
    estimated_investment: estimatedInvestment,
    expected_revenue: expectedRevenue,
    expected_margin: expectedMargin,
    lists_considered: 0,
    linked_items_considered: 0
  }

  const overview = buildFallbackNarrative(summary, minRequiredUnits)

  return {
    scenario: {
      generated_at: new Date().toISOString(),
      min_required_units: minRequiredUnits,
      fallback_cost_factor: fallbackCostFactor
    },
    summary,
    overview,
    recommendations: rows
  }
})
