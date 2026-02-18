import { createError } from 'h3'

import type { ProductsPageResult, ProductsRepository, ReplaceConversionsInput, UpsertProductCatalogInput } from '../ports'
import { getSupabaseUserClient } from '../../../utils/supabase'

export const makeSupabaseProductsRepository = (accessToken: string): ProductsRepository => {
  const supabase = getSupabaseUserClient(accessToken)

  return {
    async getPage(): Promise<ProductsPageResult> {
      const [unitsRes, productsRes] = await Promise.all([
        supabase.from('uom_catalog').select('code, label').eq('active', true).order('label'),
        supabase
          .from('product_catalog')
          .select('id, sku, name, brand, product_type, barcode, unit, sale_price, stock_on_hand, avg_cost, min_stock, active')
          .order('name')
      ])

      if (unitsRes.error) throw createError({ statusCode: 500, statusMessage: unitsRes.error.message })
      if (productsRes.error) throw createError({ statusCode: 500, statusMessage: productsRes.error.message })

      return { units: unitsRes.data || [], products: productsRes.data || [] }
    },

    async upsertCatalog(input: UpsertProductCatalogInput) {
      const name = String(input?.p_name || '').trim()
      if (!name) {
        throw createError({ statusCode: 400, statusMessage: 'Nombre obligatorio' })
      }

      const payload = {
        p_id: input?.p_id || null,
        p_sku: input?.p_sku || null,
        p_name: name,
        p_unit: input?.p_unit || 'unidad',
        p_brand: input?.p_brand || null,
        p_product_type: input?.p_product_type || null,
        p_barcode: input?.p_barcode || null,
        p_active: input?.p_active !== false,
        p_sale_price: Number(input?.p_sale_price || 0),
        p_min_stock: Number(input?.p_min_stock || 0),
        p_stock_on_hand:
          input?.p_stock_on_hand === null || typeof input?.p_stock_on_hand === 'undefined'
            ? null
            : Number(input?.p_stock_on_hand || 0),
        p_avg_cost:
          input?.p_avg_cost === null || typeof input?.p_avg_cost === 'undefined' ? null : Number(input?.p_avg_cost || 0),
        p_currency: input?.p_currency || 'PEN'
      }

      const { data, error } = await supabase.rpc('upsert_product_catalog', payload)
      if (error) throw createError({ statusCode: 500, statusMessage: error.message })

      return { id: String(data) }
    },

    async replaceConversions(input: ReplaceConversionsInput) {
      const productId = String(input?.p_product_id || '').trim()
      if (!productId) {
        throw createError({ statusCode: 400, statusMessage: 'Producto inválido' })
      }

      const { error } = await supabase.rpc('replace_product_unit_conversions', {
        p_product_id: productId,
        p_items: (input as any)?.p_items ?? []
      })

      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      return { ok: true as const }
    },

    async getConversions(productId: string) {
      const id = String(productId || '').trim()
      if (!id) {
        throw createError({ statusCode: 400, statusMessage: 'Producto inválido' })
      }

      const { data, error } = await supabase
        .from('product_unit_conversions')
        .select('unit_name, factor_to_base, is_active')
        .eq('product_id', id)
        .order('unit_name')

      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      return { items: data || [] }
    }
  }
}

