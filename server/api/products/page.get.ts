import { defineEventHandler, createError } from 'h3'

import { requireAccessToken } from '../../utils/auth'
import { getProductsPage } from '../../modules/products/app/getPage'
import { makeSupabaseProductsRepository } from '../../modules/products/infra/supabaseProductsRepository'

export default defineEventHandler(async (event) => {
  const accessToken = await requireAccessToken(event)
  const repo = makeSupabaseProductsRepository(accessToken)

  try {
    return await getProductsPage(repo)
  } catch (err: any) {
    if (err?.statusCode) throw err
    throw createError({ statusCode: 500, statusMessage: err?.message || 'Error inesperado' })
  }
})
