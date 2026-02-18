import { defineEventHandler, readBody, createError } from 'h3'

import { requireOwner } from '../../utils/auth'
import { createPresentationRule } from '../../modules/pricing/app/presentation'
import { makeSupabasePricingRepository } from '../../modules/pricing/infra/supabasePricingRepository'

type Body = {
  product_id?: string
  unit_name?: string
  customer_group?: string | null
  price_uom?: number
  priority?: number
  active?: boolean
}

export default defineEventHandler(async (event) => {
  const { accessToken } = await requireOwner(event)
  const repo = makeSupabasePricingRepository(accessToken)

  const body = (await readBody(event)) as Body
  try {
    return await createPresentationRule(repo, {
      product_id: String(body?.product_id || '').trim(),
      unit_name: String(body?.unit_name || '').trim(),
      customer_group: body?.customer_group || null,
      price_uom: Number(body?.price_uom || 0),
      priority: Number(body?.priority || 100),
      active: body?.active !== false
    })
  } catch (err: any) {
    if (err?.statusCode) throw err
    throw createError({ statusCode: 500, statusMessage: err?.message || 'Error inesperado' })
  }
})
