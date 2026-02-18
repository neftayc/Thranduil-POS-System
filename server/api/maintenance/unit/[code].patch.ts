import { defineEventHandler, readBody, createError } from 'h3'

import { requireOwner } from '../../../utils/auth'
import { updateUnit } from '../../../modules/maintenance/app/units'
import { makeSupabaseMaintenanceRepository } from '../../../modules/maintenance/infra/supabaseMaintenanceRepository'

type Body = {
  label?: string
  active?: boolean
}

export default defineEventHandler(async (event) => {
  const { accessToken } = await requireOwner(event)
  const repo = makeSupabaseMaintenanceRepository(accessToken)

  const code = String(event.context.params?.code || '').trim()
  const body = (await readBody(event)) as Body
  try {
    return await updateUnit(repo, code, { label: String(body?.label || '').trim(), active: body?.active !== false })
  } catch (err: any) {
    if (err?.statusCode) throw err
    throw createError({ statusCode: 500, statusMessage: err?.message || 'Error inesperado' })
  }
})
