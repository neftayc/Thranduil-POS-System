import { defineEventHandler, createError } from 'h3'

import { requireAccessToken } from '../../utils/auth'
import { getPurchasesPage } from '../../modules/purchases/app/getPage'
import { makeSupabasePurchasesRepository } from '../../modules/purchases/infra/supabasePurchasesRepository'

export default defineEventHandler(async (event) => {
  const accessToken = await requireAccessToken(event)
  const repo = makeSupabasePurchasesRepository(accessToken)

  try {
    return await getPurchasesPage(repo)
  } catch (err: any) {
    if (err?.statusCode) throw err
    throw createError({ statusCode: 500, statusMessage: err?.message || 'Error inesperado' })
  }
})
