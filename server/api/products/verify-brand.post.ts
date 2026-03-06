import { createError, defineEventHandler, readBody } from 'h3'

import { requireAccessToken } from '../../utils/auth'
import { getSupabaseUserClient } from '../../utils/supabase'

type Body = {
  name?: string
  brand?: string | null
  exclude_product_id?: string | null
}

const normalizeText = (value: unknown) => String(value ?? '').trim()

const normalizeBrand = (value: unknown) => {
  const raw = String(value ?? '').trim()
  return raw ? raw : null
}

export default defineEventHandler(async (event) => {
  const accessToken = await requireAccessToken(event)
  const supabase = getSupabaseUserClient(accessToken)
  const body = (await readBody(event)) as Body

  const name = normalizeText(body?.name)
  if (!name) {
    throw createError({ statusCode: 400, statusMessage: 'Nombre de producto obligatorio.' })
  }

  const requestedBrand = normalizeBrand(body?.brand)
  const excludeProductId = normalizeText(body?.exclude_product_id) || null

  const res = await supabase
    .from('product_catalog')
    .select('id, sku, name, brand, unit, stock_on_hand, avg_cost, sale_price, active')
    .ilike('name', name)
    .limit(100)

  if (res.error) {
    throw createError({ statusCode: 500, statusMessage: res.error.message })
  }

  const sameBrand = (res.data || [])
    .filter((row: any) => {
      const productId = normalizeText(row?.id)
      if (!productId) return false
      if (excludeProductId && productId === excludeProductId) return false

      const rowBrand = normalizeBrand(row?.brand)
      return rowBrand === requestedBrand
    })
    .sort((a: any, b: any) => {
      const aActive = a?.active === false ? 0 : 1
      const bActive = b?.active === false ? 0 : 1
      if (aActive !== bActive) return bActive - aActive
      return String(a?.name || '').localeCompare(String(b?.name || ''), 'es', { sensitivity: 'base' })
    })

  const match = sameBrand.length
    ? {
        id: String((sameBrand[0] as any)?.id || ''),
        sku: (sameBrand[0] as any)?.sku ? String((sameBrand[0] as any).sku) : null,
        name: String((sameBrand[0] as any)?.name || ''),
        brand: normalizeBrand((sameBrand[0] as any)?.brand),
        unit: String((sameBrand[0] as any)?.unit || 'unidad'),
        stock_on_hand: Number((sameBrand[0] as any)?.stock_on_hand || 0),
        avg_cost: Number((sameBrand[0] as any)?.avg_cost || 0),
        sale_price: Number((sameBrand[0] as any)?.sale_price || 0),
        active: (sameBrand[0] as any)?.active !== false
      }
    : null

  return {
    exists: Boolean(match),
    requested: {
      name,
      brand: requestedBrand
    },
    match,
    matches_count: sameBrand.length
  }
})
