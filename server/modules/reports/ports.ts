export type ProductProfitabilityStatus =
  | 'ganancia'
  | 'capital_recuperado'
  | 'perdida'
  | 'sin_movimiento'

export type ProductProfitabilityItem = {
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

export type ProductProfitabilitySummary = {
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

export type ProductProfitabilityPeriodCode =
  | 'recovery_2025_to_2026_03_08'
  | 'standard_from_2026_03_09'

export type ProductProfitabilityQuery = {
  period_code?: ProductProfitabilityPeriodCode
}

export type ProductProfitabilityResult = {
  generated_at: string
  period_code: ProductProfitabilityPeriodCode
  period_start: string
  period_end: string | null
  adjustments_counted_as_sales: boolean
  summary: ProductProfitabilitySummary
  items: ProductProfitabilityItem[]
}

export type ReportsRepository = {
  getProductProfitability(query?: ProductProfitabilityQuery): Promise<ProductProfitabilityResult>
}
