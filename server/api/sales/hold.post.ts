import { defineEventHandler, readBody, createError } from 'h3'

import { requireAccessToken } from '../../utils/auth'
import { holdSalesOrder } from '../../modules/sales/app/holdOrder'
import { makeSupabaseSalesRepository } from '../../modules/sales/infra/supabaseSalesRepository'

type OrderItem = {
  product_id: string
  qty: number
  unit_name: string
  price_unit: number
}

type Body = {
  customer_id?: string | null
  payment_method?: string | null
  notes?: string | null
  items?: OrderItem[]
}

export default defineEventHandler(async (event) => {
  const accessToken = await requireAccessToken(event)
  const repo = makeSupabaseSalesRepository(accessToken)

  const body = (await readBody(event)) as Body
  try {
    return await holdSalesOrder(repo, {
      customer_id: body?.customer_id || null,
      payment_method: body?.payment_method || null,
      notes: body?.notes || null,
      items: Array.isArray(body?.items) ? body.items : []
    })
  } catch (err: any) {
    if (err?.statusCode) throw err
    throw createError({ statusCode: 500, statusMessage: err?.message || 'Error inesperado' })
  }
})
