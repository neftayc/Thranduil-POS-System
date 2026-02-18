import { defineEventHandler, readBody, createError } from 'h3'

import { getUserIdFromAccessToken, requireAccessToken } from '../../utils/auth'
import { applyInventoryAdjustment } from '../../modules/inventory/app/applyAdjustment'
import { makeSupabaseInventoryRepository } from '../../modules/inventory/infra/supabaseInventoryRepository'

type Body = {
  session_id?: string
  product_id?: string
  stock_final?: number
  non_sellable?: number
  reason?: string
  reconfirmed?: boolean
  active?: boolean | null
}

export default defineEventHandler(async (event) => {
  const accessToken = await requireAccessToken(event)
  const userId = await getUserIdFromAccessToken(event)
  const repo = makeSupabaseInventoryRepository(accessToken)

  const body = (await readBody(event)) as Body
  try {
    return await applyInventoryAdjustment(repo, {
      userId,
      session_id: String(body?.session_id || '').trim(),
      product_id: String(body?.product_id || '').trim(),
      stock_final: Number(body?.stock_final || 0),
      non_sellable: Number(body?.non_sellable || 0),
      reason: String(body?.reason || '').trim(),
      reconfirmed: body?.reconfirmed === true,
      active: typeof body?.active === 'boolean' ? body.active : null
    })
  } catch (err: any) {
    if (err?.statusCode) throw err
    throw createError({ statusCode: 500, statusMessage: err?.message || 'Error inesperado' })
  }
})
