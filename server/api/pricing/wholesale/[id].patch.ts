import { defineEventHandler, readBody, createError } from 'h3'

import { requireOwner } from '../../../utils/auth'
import { updateWholesaleTier } from '../../../modules/pricing/app/wholesale'
import { makeSupabasePricingRepository } from '../../../modules/pricing/infra/supabasePricingRepository'

type Body = {
  customer_group?: string | null
  min_qty_base?: number
  unit_price_base?: number
  priority?: number
  active?: boolean
}

export default defineEventHandler(async (event) => {
  const { accessToken } = await requireOwner(event)
  const repo = makeSupabasePricingRepository(accessToken)

  const id = String(event.context.params?.id || '').trim()
  const body = (await readBody(event)) as Body
  try {
    return await updateWholesaleTier(repo, id, {
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
