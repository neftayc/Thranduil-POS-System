import { defineEventHandler, createError } from 'h3'

import { requireOwner } from '../../utils/auth'
import { getPricingCatalogs } from '../../modules/pricing/app/catalogs'
import { makeSupabasePricingRepository } from '../../modules/pricing/infra/supabasePricingRepository'

export default defineEventHandler(async (event) => {
  const { accessToken } = await requireOwner(event)
  const repo = makeSupabasePricingRepository(accessToken)

  try {
    return await getPricingCatalogs(repo)
  } catch (err: any) {
    if (err?.statusCode) throw err
    throw createError({ statusCode: 500, statusMessage: err?.message || 'Error inesperado' })
  }
})
