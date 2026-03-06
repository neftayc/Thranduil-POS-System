import { createError, defineEventHandler, getRouterParam, readBody } from 'h3'

import { requireAccessToken } from '../../../utils/auth'
import { getSupabaseUserClient } from '../../../utils/supabase'

type UpdateItem = {
  id?: string
  qty?: number
  unit_name?: string
  brand?: string | null
}

type Body = {
  items?: UpdateItem[]
}

const toNumber = (value: unknown) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const normalizeUnit = (value: unknown) =>
  String(value || '')
    .trim()
    .toLowerCase() || 'unidad'

const normalizeBrand = (value: unknown) => {
  const raw = String(value ?? '').trim()
  return raw ? raw : null
}

const resolvePurchaseCost = (product: any) => {
  const lastPurchaseCost = Math.max(0, toNumber(product?.last_purchase_cost))
  if (lastPurchaseCost > 0) return lastPurchaseCost
  return Math.max(0, toNumber(product?.avg_cost))
}

export default defineEventHandler(async (event) => {
  const accessToken = await requireAccessToken(event)
  const supabase = getSupabaseUserClient(accessToken)

  const quoteId = String(getRouterParam(event, 'id') || '').trim()
  if (!quoteId) {
    throw createError({ statusCode: 400, statusMessage: 'Cotización inválida.' })
  }

  const body = (await readBody(event)) as Body
  const updates = Array.isArray(body?.items) ? body.items : []
  if (!updates.length) {
    throw createError({ statusCode: 400, statusMessage: 'No hay cambios para guardar.' })
  }

  const quoteRes = await supabase
    .from('supplier_quotes')
    .select('id')
    .eq('id', quoteId)
    .single()

  if (quoteRes.error || !quoteRes.data?.id) {
    if (String(quoteRes.error?.code || '') === 'PGRST116') {
      throw createError({ statusCode: 404, statusMessage: 'Cotización no encontrada.' })
    }
    throw createError({ statusCode: 500, statusMessage: quoteRes.error?.message || 'No se pudo validar cotización.' })
  }

  const existingRes = await supabase
    .from('supplier_quote_items')
    .select('id, product_id, qty, unit_name, cost_unit, product_snapshot_brand')
    .eq('quote_id', quoteId)

  if (existingRes.error) {
    throw createError({ statusCode: 500, statusMessage: existingRes.error.message })
  }

  const existingById = new Map<
    string,
    { id: string; product_id: string; qty: number; unit_name: string; cost_unit: number; brand: string | null }
  >()
  const productIds = new Set<string>()
  for (const row of existingRes.data || []) {
    const id = String((row as any)?.id || '').trim()
    if (!id) continue
    const productId = String((row as any)?.product_id || '').trim()

    existingById.set(id, {
      id,
      product_id: productId,
      qty: toNumber((row as any)?.qty),
      unit_name: normalizeUnit((row as any)?.unit_name),
      cost_unit: toNumber((row as any)?.cost_unit),
      brand: normalizeBrand((row as any)?.product_snapshot_brand)
    })
    if (productId) productIds.add(productId)
  }

  const factorByProductUnit = new Map<string, number>()
  const purchaseCostByProduct = new Map<string, number>()
  const productIdList = Array.from(productIds)
  if (productIdList.length) {
    const [conversionsRes, productsRes] = await Promise.all([
      supabase
        .from('product_unit_conversions')
        .select('product_id, unit_name, factor_to_base, is_active')
        .in('product_id', productIdList)
        .eq('is_active', true),
      supabase
        .from('product_catalog')
        .select('id, avg_cost, last_purchase_cost')
        .in('id', productIdList)
    ])

    if (conversionsRes.error) {
      throw createError({ statusCode: 500, statusMessage: conversionsRes.error.message })
    }
    if (productsRes.error) {
      throw createError({ statusCode: 500, statusMessage: productsRes.error.message })
    }

    for (const row of conversionsRes.data || []) {
      const productId = String((row as any)?.product_id || '').trim()
      if (!productId) continue
      const unitName = normalizeUnit((row as any)?.unit_name)
      const factor = Number((row as any)?.factor_to_base || 0)
      if (!Number.isFinite(factor) || factor <= 0) continue
      factorByProductUnit.set(`${productId}|${unitName}`, factor)
    }

    for (const row of productsRes.data || []) {
      const productId = String((row as any)?.id || '').trim()
      if (!productId) continue
      purchaseCostByProduct.set(productId, Number(resolvePurchaseCost(row).toFixed(4)))
    }
  }

  const factorFor = (productId: string, unitName: string) => {
    const key = `${String(productId || '').trim()}|${normalizeUnit(unitName)}`
    const factor = Number(factorByProductUnit.get(key) || 0)
    return Number.isFinite(factor) && factor > 0 ? factor : 1
  }

  for (const raw of updates) {
    const itemId = String(raw?.id || '').trim()
    const nextQty = Number(toNumber(raw?.qty).toFixed(3))
    if (!itemId || !existingById.has(itemId)) {
      throw createError({ statusCode: 400, statusMessage: 'Item de cotización inválido.' })
    }
    if (!Number.isFinite(nextQty) || nextQty <= 0) {
      throw createError({ statusCode: 400, statusMessage: 'La cantidad debe ser mayor a 0.' })
    }

    const existing = existingById.get(itemId)!
    const nextUnitName = normalizeUnit(raw?.unit_name || existing.unit_name || 'unidad')
    const nextBrand = Object.prototype.hasOwnProperty.call(raw, 'brand')
      ? normalizeBrand(raw?.brand)
      : existing.brand
    const factorToBase = factorFor(existing.product_id, nextUnitName)
    const purchaseCost = Number(purchaseCostByProduct.get(existing.product_id) || existing.cost_unit || 0)
    const lineCostUnit = Number(Math.max(0, purchaseCost).toFixed(4))
    const lineTotal = Number((nextQty * factorToBase * lineCostUnit).toFixed(2))

    const updateRes = await supabase
      .from('supplier_quote_items')
      .update({
        qty: nextQty,
        unit_name: nextUnitName,
        product_snapshot_brand: nextBrand,
        cost_unit: lineCostUnit,
        line_total: lineTotal
      })
      .eq('id', itemId)
      .eq('quote_id', quoteId)

    if (updateRes.error) {
      throw createError({ statusCode: 500, statusMessage: updateRes.error.message })
    }
  }

  const recalcRes = await supabase
    .from('supplier_quote_items')
    .select('product_id, qty, unit_name, line_total')
    .eq('quote_id', quoteId)

  if (recalcRes.error) {
    throw createError({ statusCode: 500, statusMessage: recalcRes.error.message })
  }

  const rows = recalcRes.data || []
  const totalItems = rows.length
  const totalUnits = Number(
    rows
      .reduce((sum: number, item: any) => {
        const productId = String(item?.product_id || '').trim()
        const unitName = normalizeUnit(item?.unit_name)
        const factorToBase = factorFor(productId, unitName)
        return sum + toNumber(item?.qty) * factorToBase
      }, 0)
      .toFixed(3)
  )
  const totalCost = Number(rows.reduce((sum: number, item: any) => sum + toNumber(item?.line_total), 0).toFixed(2))

  const quoteUpdateRes = await supabase
    .from('supplier_quotes')
    .update({
      total_items: totalItems,
      total_units: totalUnits,
      total_cost: totalCost,
      updated_at: new Date().toISOString()
    })
    .eq('id', quoteId)

  if (quoteUpdateRes.error) {
    throw createError({ statusCode: 500, statusMessage: quoteUpdateRes.error.message })
  }

  return {
    ok: true,
    quote_id: quoteId,
    total_items: totalItems,
    total_units: totalUnits,
    total_cost: totalCost
  }
})
