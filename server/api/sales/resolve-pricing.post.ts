import { defineEventHandler, readBody, createError } from 'h3'

import { requireAccessToken } from '../../utils/auth'
import { resolveSaleItemPricing } from '../../modules/sales/app/resolvePricing'
import { makeSupabaseSalesRepository } from '../../modules/sales/infra/supabaseSalesRepository'

type Body = {
  product_id?: string
  unit_name?: string
  qty_uom?: number
  customer_id?: string | null
  sale_at?: string
}

export default defineEventHandler(async (event) => {
  const accessToken = await requireAccessToken(event)
  const repo = makeSupabaseSalesRepository(accessToken)

  const body = (await readBody(event)) as Body
  try {
    return await resolveSaleItemPricing(repo, {
      product_id: String(body?.product_id || '').trim(),
      unit_name: String(body?.unit_name || '').trim(),
      qty_uom: Number(body?.qty_uom || 0),
      customer_id: body?.customer_id || null,
      sale_at: String(body?.sale_at || new Date().toISOString())
    })
  } catch (err: any) {
    if (err?.statusCode) throw err
    throw createError({ statusCode: 500, statusMessage: err?.message || 'Error inesperado' })
  }
})
