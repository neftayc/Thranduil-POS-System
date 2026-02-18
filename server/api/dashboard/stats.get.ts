import { defineEventHandler, createError } from 'h3'

import { requireAccessToken } from '../../utils/auth'
import { getDashboardStats } from '../../modules/dashboard/app/getStats'
import { makeSupabaseDashboardRepository } from '../../modules/dashboard/infra/supabaseDashboardRepository'

export default defineEventHandler(async (event) => {
  const accessToken = await requireAccessToken(event)
  const repo = makeSupabaseDashboardRepository(accessToken)

  try {
    return await getDashboardStats(repo)
  } catch (err: any) {
    if (err?.statusCode) throw err
    throw createError({ statusCode: 500, statusMessage: err?.message || 'Error inesperado' })
  }
})
