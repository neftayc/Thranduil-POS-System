import { defineEventHandler, readBody, createError } from 'h3'

import { getUserIdFromAccessToken, requireAccessToken } from '../../utils/auth'
import { startInventorySession } from '../../modules/inventory/app/startSession'
import { makeSupabaseInventoryRepository } from '../../modules/inventory/infra/supabaseInventoryRepository'

type Body = {
  notes?: string | null
}

export default defineEventHandler(async (event) => {
  const accessToken = await requireAccessToken(event)
  const userId = await getUserIdFromAccessToken(event)
  const repo = makeSupabaseInventoryRepository(accessToken)

  const body = (await readBody(event)) as Body
  const notes = String(body?.notes || '').trim()

  try {
    return await startInventorySession(repo, { userId, notes: notes || null })
  } catch (err: any) {
    if (err?.statusCode) throw err
    throw createError({ statusCode: 500, statusMessage: err?.message || 'Error inesperado' })
  }
})
