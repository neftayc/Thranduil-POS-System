import { defineEventHandler, readBody, createError } from 'h3'

import { requireOwner } from '../../utils/auth'
import { createWholesaleTier } from '../../modules/pricing/app/wholesale'
import { makeSupabasePricingRepository } from '../../modules/pricing/infra/supabasePricingRepository'

type Body = {
  product_id?: string
  customer_group?: string | null
  min_qty_base?: number
  unit_price_base?: number
  priority?: number
  active?: boolean
}

export default defineEventHandler(async (event) => {
  const { accessToken } = await requireOwner(event)
  const repo = makeSupabasePricingRepository(accessToken)

  const body = (await readBody(event)) as Body
  try {
    return await createWholesaleTier(repo, {
      product_id: String(body?.product_id || '').trim(),
      customer_group: body?.customer_group || null,
      min_qty_base: Number(body?.min_qty_base || 1),
      unit_price_base: Number(body?.unit_price_base || 0),
      priority: Number(body?.priority || 100),
      active: body?.active !== false
    })
  } catch (err: any) {
    if (err?.statusCode) throw err
    throw createError({ statusCode: 500, statusMessage: err?.message || 'Error inesperado' })
  }
})
