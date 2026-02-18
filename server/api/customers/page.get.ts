import { defineEventHandler, createError } from 'h3'

import { requireAccessToken } from '../../utils/auth'
import { getCustomersPage } from '../../modules/customers/app/getPage'
import { makeSupabaseCustomersRepository } from '../../modules/customers/infra/supabaseCustomersRepository'

export default defineEventHandler(async (event) => {
  const accessToken = await requireAccessToken(event)
  const repo = makeSupabaseCustomersRepository(accessToken)

  try {
    return await getCustomersPage(repo)
  } catch (err: any) {
    if (err?.statusCode) throw err
    throw createError({ statusCode: 500, statusMessage: err?.message || 'Error inesperado' })
  }
})
