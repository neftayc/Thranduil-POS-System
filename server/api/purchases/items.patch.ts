import { createError, defineEventHandler, readBody } from 'h3'

import { updatePurchaseItems } from '../../modules/purchases/app/updateItems'
import { makeSupabasePurchasesRepository } from '../../modules/purchases/infra/supabasePurchasesRepository'
import { requireAccessToken } from '../../utils/auth'

type BodyItem = {
  id: string
  qty: number
  unit_name: string
  cost_unit: number
}

type Body = {
  purchase_id?: string
  items?: BodyItem[]
}

export default defineEventHandler(async (event) => {
  const accessToken = await requireAccessToken(event)
  const repo = makeSupabasePurchasesRepository(accessToken)
  const body = (await readBody(event)) as Body

  try {
    return await updatePurchaseItems(repo, {
      purchase_id: String(body?.purchase_id || ''),
      items: Array.isArray(body?.items) ? body.items : []
    })
  } catch (err: any) {
    if (err?.statusCode) throw err
    throw createError({ statusCode: 500, statusMessage: err?.message || 'Error inesperado' })
  }
})
