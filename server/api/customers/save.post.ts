import { defineEventHandler, readBody, createError } from 'h3'

import { requireAccessToken } from '../../utils/auth'
import { saveCustomer } from '../../modules/customers/app/saveCustomer'
import { makeSupabaseCustomersRepository } from '../../modules/customers/infra/supabaseCustomersRepository'

type Body = {
  id?: string
  name?: string
  phone?: string | null
  email?: string | null
  address?: string | null
  notes?: string | null
  customer_group?: string | null
}

export default defineEventHandler(async (event) => {
  const accessToken = await requireAccessToken(event)
  const repo = makeSupabaseCustomersRepository(accessToken)

  const body = (await readBody(event)) as Body
  try {
    return await saveCustomer(repo, {
      id: String(body?.id || '').trim() || undefined,
      name: String(body?.name || '').trim(),
      phone: body?.phone ? String(body.phone).trim() : null,
      email: body?.email ? String(body.email).trim() : null,
      address: body?.address ? String(body.address).trim() : null,
      notes: body?.notes ? String(body.notes).trim() : null,
      customer_group: body?.customer_group ? String(body.customer_group).trim() : null
    })
  } catch (err: any) {
    if (err?.statusCode) throw err
    throw createError({ statusCode: 500, statusMessage: err?.message || 'Error inesperado' })
  }
})
