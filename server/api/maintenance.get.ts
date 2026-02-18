import { defineEventHandler, createError } from 'h3'

import { requireOwner } from '../utils/auth'
import { getMaintenanceData } from '../modules/maintenance/app/getAll'
import { makeSupabaseMaintenanceRepository } from '../modules/maintenance/infra/supabaseMaintenanceRepository'

export default defineEventHandler(async (event) => {
  const { accessToken } = await requireOwner(event)
  const repo = makeSupabaseMaintenanceRepository(accessToken)

  try {
    return await getMaintenanceData(repo)
  } catch (err: any) {
    if (err?.statusCode) throw err
    throw createError({ statusCode: 500, statusMessage: err?.message || 'Error inesperado' })
  }
})
