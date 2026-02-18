import { createError } from 'h3'

import type { CreatePurchaseInput, PurchasesPageResult, PurchasesRepository } from '../ports'
import { getSupabaseUserClient } from '../../../utils/supabase'

export const makeSupabasePurchasesRepository = (accessToken: string): PurchasesRepository => {
  const supabase = getSupabaseUserClient(accessToken)

  return {
    async getPage(): Promise<PurchasesPageResult> {
      const [uomRes, suppliersRes, productsRes, conversionsRes, historyRes] = await Promise.all([
        supabase.from('uom_catalog').select('code, label').eq('active', true).order('label'),
        supabase.from('suppliers').select('id, name').order('name'),
        supabase.from('product_catalog').select('id, name, unit, avg_cost').order('name'),
        supabase
          .from('product_unit_conversions')
          .select('product_id, unit_name, factor_to_base, is_active')
          .eq('is_active', true),
        supabase
          .from('purchases')
          .select(
            `
        id,
        invoice_no,
        purchase_date,
        total_cost,
        created_at,
        suppliers (name),
        purchase_items (
          id,
          unit_name,
          qty_uom,
          factor_to_base,
          cost_unit_uom,
          qty,
          cost_unit,
          total_cost,
          products (name, unit)
        )
      `
          )
          .order('created_at', { ascending: false })
          .limit(50)
      ])

      if (uomRes.error) throw createError({ statusCode: 500, statusMessage: uomRes.error.message })
      if (suppliersRes.error) throw createError({ statusCode: 500, statusMessage: suppliersRes.error.message })
      if (productsRes.error) throw createError({ statusCode: 500, statusMessage: productsRes.error.message })
      if (conversionsRes.error) throw createError({ statusCode: 500, statusMessage: conversionsRes.error.message })
      if (historyRes.error) throw createError({ statusCode: 500, statusMessage: historyRes.error.message })

      return {
        uomCatalog: uomRes.data || [],
        suppliers: suppliersRes.data || [],
        products: productsRes.data || [],
        conversions: conversionsRes.data || [],
        history: historyRes.data || []
      }
    },

    async createPurchase(input: CreatePurchaseInput) {
      const items = Array.isArray(input?.items) ? input.items : []
      if (!items.length) {
        throw createError({ statusCode: 400, statusMessage: 'Items inválidos' })
      }

      const { error } = await supabase.rpc('create_purchase', {
        p_supplier_id: input?.supplier_id || null,
        p_invoice_no: input?.invoice_no || null,
        p_items: items
      })

      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      return { ok: true as const }
    }
  }
}

