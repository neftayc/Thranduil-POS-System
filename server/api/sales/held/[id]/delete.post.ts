import { defineEventHandler, createError } from 'h3'

import { requireAccessToken } from '../../../../utils/auth'
import { deleteHeldSalesOrder } from '../../../../modules/sales/app/deleteHeld'
import { makeSupabaseSalesRepository } from '../../../../modules/sales/infra/supabaseSalesRepository'

export default defineEventHandler(async (event) => {
  const accessToken = await requireAccessToken(event)
  const repo = makeSupabaseSalesRepository(accessToken)

  const id = String(event.context.params?.id || '').trim()
  try {
    return await deleteHeldSalesOrder(repo, id)
  } catch (err: any) {
    if (err?.statusCode) throw err
    throw createError({ statusCode: 500, statusMessage: err?.message || 'Error inesperado' })
  }
})
