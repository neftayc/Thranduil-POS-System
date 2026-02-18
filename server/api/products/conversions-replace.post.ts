import { defineEventHandler, readBody, createError } from 'h3'

import { requireAccessToken } from '../../utils/auth'
import { replaceProductUnitConversions } from '../../modules/products/app/replaceConversions'
import { makeSupabaseProductsRepository } from '../../modules/products/infra/supabaseProductsRepository'

type Body = {
  p_product_id?: string
  p_items?: any
}

export default defineEventHandler(async (event) => {
  const accessToken = await requireAccessToken(event)
  const repo = makeSupabaseProductsRepository(accessToken)

  const body = (await readBody(event)) as Body
  try {
    return await replaceProductUnitConversions(repo, {
      p_product_id: String(body?.p_product_id || '').trim(),
      p_items: body?.p_items ?? []
    })
  } catch (err: any) {
    if (err?.statusCode) throw err
    throw createError({ statusCode: 500, statusMessage: err?.message || 'Error inesperado' })
  }
})
