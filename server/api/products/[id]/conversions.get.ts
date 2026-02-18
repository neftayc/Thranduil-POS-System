import { defineEventHandler, createError } from 'h3'

import { requireAccessToken } from '../../../utils/auth'
import { getProductUnitConversions } from '../../../modules/products/app/getConversions'
import { makeSupabaseProductsRepository } from '../../../modules/products/infra/supabaseProductsRepository'

export default defineEventHandler(async (event) => {
  const accessToken = await requireAccessToken(event)
  const repo = makeSupabaseProductsRepository(accessToken)

  const productId = String(event.context.params?.id || '').trim()
  try {
    return await getProductUnitConversions(repo, productId)
  } catch (err: any) {
    if (err?.statusCode) throw err
    throw createError({ statusCode: 500, statusMessage: err?.message || 'Error inesperado' })
  }
})
