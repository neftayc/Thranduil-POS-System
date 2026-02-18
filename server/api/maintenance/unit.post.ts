import { defineEventHandler, readBody, createError } from 'h3'

import { requireOwner } from '../../utils/auth'
import { createUnit } from '../../modules/maintenance/app/units'
import { makeSupabaseMaintenanceRepository } from '../../modules/maintenance/infra/supabaseMaintenanceRepository'

type Body = {
  code?: string
  label?: string
}

export default defineEventHandler(async (event) => {
  const { accessToken } = await requireOwner(event)
  const repo = makeSupabaseMaintenanceRepository(accessToken)

  const body = (await readBody(event)) as Body
  try {
    return await createUnit(repo, { code: String(body?.code || '').trim(), label: String(body?.label || '').trim() })
  } catch (err: any) {
    if (err?.statusCode) throw err
    throw createError({ statusCode: 500, statusMessage: err?.message || 'Error inesperado' })
  }
})
