import { defineEventHandler, readBody, createError } from 'h3'

import { requireOwner } from '../../utils/auth'
import { createPromotion } from '../../modules/pricing/app/promotion'
import { makeSupabasePricingRepository } from '../../modules/pricing/infra/supabasePricingRepository'

type Body = {
  product_id?: string
  name?: string
  unit_name?: string | null
  customer_group?: string | null
  promo_type?: string
  promo_value?: number
  min_qty_base?: number
  starts_at?: string | null
  ends_at?: string | null
  priority?: number
  active?: boolean
}

export default defineEventHandler(async (event) => {
  const { accessToken } = await requireOwner(event)
  const repo = makeSupabasePricingRepository(accessToken)

  const body = (await readBody(event)) as Body
  try {
    return await createPromotion(repo, {
      product_id: String(body?.product_id || '').trim(),
      name: String(body?.name || '').trim(),
      unit_name: body?.unit_name || null,
      customer_group: body?.customer_group || null,
      promo_type: body?.promo_type || 'percent',
      promo_value: Number(body?.promo_value || 0),
      min_qty_base: Number(body?.min_qty_base || 1),
      starts_at: body?.starts_at || null,
      ends_at: body?.ends_at || null,
      priority: Number(body?.priority || 100),
      active: body?.active !== false
    })
  } catch (err: any) {
    if (err?.statusCode) throw err
    throw createError({ statusCode: 500, statusMessage: err?.message || 'Error inesperado' })
  }
})
