import { defineEventHandler, createError } from 'h3'

import { requireAccessToken } from '../utils/auth'
import { listSuppliers } from '../modules/suppliers/app/listSuppliers'
import { makeSupabaseSuppliersRepository } from '../modules/suppliers/infra/supabaseSuppliersRepository'

export default defineEventHandler(async (event) => {
  const accessToken = await requireAccessToken(event)
  const repo = makeSupabaseSuppliersRepository(accessToken)

  try {
    return await listSuppliers(repo)
  } catch (err: any) {
    if (err?.statusCode) throw err
    throw createError({ statusCode: 500, statusMessage: err?.message || 'Error inesperado' })
  }
})
