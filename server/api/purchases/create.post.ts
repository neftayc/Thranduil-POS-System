import { defineEventHandler, readBody, createError } from 'h3'

import { requireAccessToken } from '../../utils/auth'
import { createPurchase } from '../../modules/purchases/app/createPurchase'
import { makeSupabasePurchasesRepository } from '../../modules/purchases/infra/supabasePurchasesRepository'

type PurchaseItem = {
  product_id: string
  qty: number
  unit_name: string
  cost_unit: number
}

type Body = {
  supplier_id?: string | null
  invoice_no?: string | null
  items?: PurchaseItem[]
}

export default defineEventHandler(async (event) => {
  const accessToken = await requireAccessToken(event)
  const repo = makeSupabasePurchasesRepository(accessToken)

  const body = (await readBody(event)) as Body
  try {
    return await createPurchase(repo, {
      supplier_id: body?.supplier_id || null,
      invoice_no: body?.invoice_no || null,
      items: Array.isArray(body?.items) ? body.items : []
    })
  } catch (err: any) {
    if (err?.statusCode) throw err
    throw createError({ statusCode: 500, statusMessage: err?.message || 'Error inesperado' })
  }
})
