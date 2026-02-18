import { defineEventHandler, createError } from 'h3'

import { requireAccessToken } from '../../utils/auth'
import { listHeldSalesOrders } from '../../modules/sales/app/listHeld'
import { makeSupabaseSalesRepository } from '../../modules/sales/infra/supabaseSalesRepository'

export default defineEventHandler(async (event) => {
  const accessToken = await requireAccessToken(event)
  const repo = makeSupabaseSalesRepository(accessToken)

  try {
    return await listHeldSalesOrders(repo)
  } catch (err: any) {
    if (err?.statusCode) throw err
    throw createError({ statusCode: 500, statusMessage: err?.message || 'Error inesperado' })
  }
})
