import { defineEventHandler, readBody, createError } from 'h3'

import { requireOwner } from '../../utils/auth'
import { createCustomerGroup } from '../../modules/maintenance/app/customerGroups'
import { makeSupabaseMaintenanceRepository } from '../../modules/maintenance/infra/supabaseMaintenanceRepository'

type Body = {
  code?: string
  label?: string
  sort_order?: number
}

export default defineEventHandler(async (event) => {
  const { accessToken } = await requireOwner(event)
  const repo = makeSupabaseMaintenanceRepository(accessToken)

  const body = (await readBody(event)) as Body
  try {
    return await createCustomerGroup(repo, {
      code: String(body?.code || '').trim(),
      label: String(body?.label || '').trim(),
      sort_order: Number(body?.sort_order || 100)
    })
  } catch (err: any) {
    if (err?.statusCode) throw err
    throw createError({ statusCode: 500, statusMessage: err?.message || 'Error inesperado' })
  }
})
