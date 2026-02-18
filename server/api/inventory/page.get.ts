import { defineEventHandler, createError } from 'h3'

import { requireAccessToken } from '../../utils/auth'
import { getInventoryPage } from '../../modules/inventory/app/getPage'
import { makeSupabaseInventoryRepository } from '../../modules/inventory/infra/supabaseInventoryRepository'

export default defineEventHandler(async (event) => {
  const accessToken = await requireAccessToken(event)
  const repo = makeSupabaseInventoryRepository(accessToken)

  try {
    return await getInventoryPage(repo)
  } catch (err: any) {
    // Preserve existing error surface for callers.
    if (err?.statusCode) throw err
    throw createError({ statusCode: 500, statusMessage: err?.message || 'Error inesperado' })
  }
})
