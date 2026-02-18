import { defineEventHandler, readBody, createError } from 'h3'

import { getUserIdFromAccessToken, requireAccessToken } from '../../utils/auth'
import { closeInventorySession } from '../../modules/inventory/app/closeSession'
import { makeSupabaseInventoryRepository } from '../../modules/inventory/infra/supabaseInventoryRepository'

type Body = {
  session_id?: string
  notes?: string | null
}

export default defineEventHandler(async (event) => {
  const accessToken = await requireAccessToken(event)
  const userId = await getUserIdFromAccessToken(event)
  const repo = makeSupabaseInventoryRepository(accessToken)

  const body = (await readBody(event)) as Body
  try {
    return await closeInventorySession(repo, {
      userId,
      session_id: String(body?.session_id || '').trim(),
      notes: String(body?.notes || '').trim() || null
    })
  } catch (err: any) {
    if (err?.statusCode) throw err
    throw createError({ statusCode: 500, statusMessage: err?.message || 'Error inesperado' })
  }
})
