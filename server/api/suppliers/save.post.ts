import { defineEventHandler, readBody, createError } from 'h3'

import { requireAccessToken } from '../../utils/auth'
import { saveSupplier } from '../../modules/suppliers/app/saveSupplier'
import { makeSupabaseSuppliersRepository } from '../../modules/suppliers/infra/supabaseSuppliersRepository'

type Body = {
  id?: string
  name?: string
  phone?: string | null
  email?: string | null
  address?: string | null
  notes?: string | null
}

export default defineEventHandler(async (event) => {
  const accessToken = await requireAccessToken(event)
  const repo = makeSupabaseSuppliersRepository(accessToken)

  const body = (await readBody(event)) as Body
  try {
    return await saveSupplier(repo, {
      id: String(body?.id || '').trim() || undefined,
      name: String(body?.name || '').trim(),
      phone: body?.phone ? String(body.phone).trim() : null,
      email: body?.email ? String(body.email).trim() : null,
      address: body?.address ? String(body.address).trim() : null,
      notes: body?.notes ? String(body.notes).trim() : null
    })
  } catch (err: any) {
    if (err?.statusCode) throw err
    throw createError({ statusCode: 500, statusMessage: err?.message || 'Error inesperado' })
  }
})
