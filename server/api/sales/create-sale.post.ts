import { defineEventHandler, readBody, createError } from 'h3'

import { requireAccessToken } from '../../utils/auth'
import { createSale } from '../../modules/sales/app/createSale'
import { makeSupabaseSalesRepository } from '../../modules/sales/infra/supabaseSalesRepository'

type SaleItem = {
  product_id: string
  qty: number
  unit_name: string
  price_unit: number
}

type Body = {
  customer_id?: string | null
  payment_method?: string | null
  items?: SaleItem[]
}

export default defineEventHandler(async (event) => {
  const accessToken = await requireAccessToken(event)
  const repo = makeSupabaseSalesRepository(accessToken)

  const body = (await readBody(event)) as Body
  try {
    return await createSale(repo, {
      customer_id: body?.customer_id || null,
      payment_method: body?.payment_method || null,
      items: Array.isArray(body?.items) ? (body.items as any) : []
    })
  } catch (err: any) {
    if (err?.statusCode) throw err
    throw createError({ statusCode: 500, statusMessage: err?.message || 'Error inesperado' })
  }
})
