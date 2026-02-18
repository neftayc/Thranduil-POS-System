import { defineEventHandler, readBody, createError } from 'h3'

import { requireOwner } from '../../../utils/auth'
import { updatePresentationRule } from '../../../modules/pricing/app/presentation'
import { makeSupabasePricingRepository } from '../../../modules/pricing/infra/supabasePricingRepository'

type Body = {
  unit_name?: string
  customer_group?: string | null
  price_uom?: number
  priority?: number
  active?: boolean
}

export default defineEventHandler(async (event) => {
  const { accessToken } = await requireOwner(event)
  const repo = makeSupabasePricingRepository(accessToken)

  const id = String(event.context.params?.id || '').trim()
  const body = (await readBody(event)) as Body
  try {
    return await updatePresentationRule(repo, id, {
      unit_name: typeof body?.unit_name === 'undefined' ? undefined : String(body.unit_name).trim(),
      customer_group: typeof body?.customer_group === 'undefined' ? undefined : body?.customer_group || null,
      price_uom: typeof body?.price_uom === 'undefined' ? undefined : Number(body?.price_uom || 0),
      priority: typeof body?.priority === 'undefined' ? undefined : Number(body?.priority || 100),
      active: typeof body?.active === 'undefined' ? undefined : body?.active !== false
    })
  } catch (err: any) {
    if (err?.statusCode) throw err
    throw createError({ statusCode: 500, statusMessage: err?.message || 'Error inesperado' })
  }
})
