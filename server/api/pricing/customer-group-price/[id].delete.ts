import { defineEventHandler, createError } from 'h3'

import { requireOwner } from '../../../utils/auth'
import { deleteCustomerGroupPrice } from '../../../modules/pricing/app/customerGroupPrice'
import { makeSupabasePricingRepository } from '../../../modules/pricing/infra/supabasePricingRepository'

export default defineEventHandler(async (event) => {
  const { accessToken } = await requireOwner(event)
  const repo = makeSupabasePricingRepository(accessToken)

  const id = String(event.context.params?.id || '').trim()
  try {
    return await deleteCustomerGroupPrice(repo, id)
  } catch (err: any) {
    if (err?.statusCode) throw err
    throw createError({ statusCode: 500, statusMessage: err?.message || 'Error inesperado' })
  }
})
