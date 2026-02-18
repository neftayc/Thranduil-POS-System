import { createError } from 'h3'

import type { DashboardRepository, DashboardStatsResult } from '../ports'
import { getSupabaseUserClient } from '../../../utils/supabase'

export const makeSupabaseDashboardRepository = (accessToken: string): DashboardRepository => {
  const supabase = getSupabaseUserClient(accessToken)

  return {
    async getStats(): Promise<DashboardStatsResult> {
      const [productsRes, purchasesRes, salesRes, movementsRes] = await Promise.all([
        supabase.from('product_catalog').select('id, name, stock_on_hand, min_stock, avg_cost, sale_price, active'),
        supabase.from('purchases').select('id, total_cost'),
        supabase.from('sales').select('id, total'),
        supabase
          .from('stock_movements')
          .select('movement_type, qty, cost_unit')
          .eq('movement_type', 'sale')
      ])

      if (productsRes.error) throw createError({ statusCode: 500, statusMessage: productsRes.error.message })
      if (purchasesRes.error) throw createError({ statusCode: 500, statusMessage: purchasesRes.error.message })
      if (salesRes.error) throw createError({ statusCode: 500, statusMessage: salesRes.error.message })
      if (movementsRes.error) throw createError({ statusCode: 500, statusMessage: movementsRes.error.message })

      return {
        products: productsRes.data || [],
        purchases: purchasesRes.data || [],
        sales: salesRes.data || [],
        saleMovements: movementsRes.data || []
      }
    }
  }
}

