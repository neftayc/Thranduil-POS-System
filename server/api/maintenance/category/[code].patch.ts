import { defineEventHandler, readBody, createError } from 'h3'

import { requireOwner } from '../../../utils/auth'
import { updateCategory } from '../../../modules/maintenance/app/categories'
import { makeSupabaseMaintenanceRepository } from '../../../modules/maintenance/infra/supabaseMaintenanceRepository'

type Body = {
  label?: string
  active?: boolean
  sort_order?: number
}

export default defineEventHandler(async (event) => {
  const { accessToken } = await requireOwner(event)
  const repo = makeSupabaseMaintenanceRepository(accessToken)

  const code = String(event.context.params?.code || '').trim()
  const body = (await readBody(event)) as Body
  try {
    return await updateCategory(repo, code, {
      label: String(body?.label || '').trim(),
      active: body?.active !== false,
      sort_order: Number(body?.sort_order || 100)
    })
  } catch (err: any) {
    if (err?.statusCode) throw err
    throw createError({ statusCode: 500, statusMessage: err?.message || 'Error inesperado' })
  }
})
