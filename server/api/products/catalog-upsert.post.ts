import { defineEventHandler, readBody, createError } from 'h3'

import { requireAccessToken } from '../../utils/auth'
import { upsertProductCatalog } from '../../modules/products/app/upsertCatalog'
import { makeSupabaseProductsRepository } from '../../modules/products/infra/supabaseProductsRepository'

type Body = {
  p_id?: string | null
  p_sku?: string | null
  p_name?: string
  p_unit?: string | null
  p_brand?: string | null
  p_product_type?: string | null
  p_barcode?: string | null
  p_active?: boolean
  p_sale_price?: number
  p_min_stock?: number
  p_stock_on_hand?: number | null
  p_avg_cost?: number | null
  p_currency?: string
}

export default defineEventHandler(async (event) => {
  const accessToken = await requireAccessToken(event)
  const repo = makeSupabaseProductsRepository(accessToken)

  const body = (await readBody(event)) as Body
  try {
    return await upsertProductCatalog(repo, {
      p_id: body?.p_id ?? null,
      p_sku: body?.p_sku ?? null,
      p_name: String(body?.p_name || '').trim(),
      p_unit: body?.p_unit ?? null,
      p_brand: body?.p_brand ?? null,
      p_product_type: body?.p_product_type ?? null,
      p_barcode: body?.p_barcode ?? null,
      p_active: body?.p_active,
      p_sale_price: body?.p_sale_price,
      p_min_stock: body?.p_min_stock,
      p_stock_on_hand: typeof body?.p_stock_on_hand === 'undefined' ? null : body?.p_stock_on_hand,
      p_avg_cost: typeof body?.p_avg_cost === 'undefined' ? null : body?.p_avg_cost,
      p_currency: body?.p_currency
    })
  } catch (err: any) {
    if (err?.statusCode) throw err
    throw createError({ statusCode: 500, statusMessage: err?.message || 'Error inesperado' })
  }
})
