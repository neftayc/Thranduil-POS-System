import { defineEventHandler, readBody, createError } from 'h3'

import { requireAccessToken } from '../../../../utils/auth'
import { payHeldSalesOrder } from '../../../../modules/sales/app/payHeld'
import { makeSupabaseSalesRepository } from '../../../../modules/sales/infra/supabaseSalesRepository'

type Body = {
  payment_method?: string | null
}

export default defineEventHandler(async (event) => {
  const accessToken = await requireAccessToken(event)
  const repo = makeSupabaseSalesRepository(accessToken)

  const id = String(event.context.params?.id || '').trim()
  const body = (await readBody(event)) as Body

  try {
    return await payHeldSalesOrder(repo, id, body?.payment_method || null)
  } catch (err: any) {
    if (err?.statusCode) throw err
    throw createError({ statusCode: 500, statusMessage: err?.message || 'Error inesperado' })
  }
})
