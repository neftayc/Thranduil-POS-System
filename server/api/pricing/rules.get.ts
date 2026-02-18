import { defineEventHandler, getQuery, createError } from 'h3'

import { requireOwner } from '../../utils/auth'
import { getPricingRules } from '../../modules/pricing/app/rules'
import { makeSupabasePricingRepository } from '../../modules/pricing/infra/supabasePricingRepository'

export default defineEventHandler(async (event) => {
  const { accessToken } = await requireOwner(event)
  const repo = makeSupabasePricingRepository(accessToken)

  const query = getQuery(event)
  const productId = String(query.product_id || '').trim()
  try {
    return await getPricingRules(repo, productId)
  } catch (err: any) {
    if (err?.statusCode) throw err
    throw createError({ statusCode: 500, statusMessage: err?.message || 'Error inesperado' })
  }
})
