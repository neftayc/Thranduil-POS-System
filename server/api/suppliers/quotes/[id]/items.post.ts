import { createError, defineEventHandler, getRouterParam, readBody } from 'h3'

import { requireAccessToken } from '../../../../utils/auth'
import { getSupabaseUserClient } from '../../../../utils/supabase'

type Body = {
  product_id?: string
  qty?: number
  suggested_qty?: number
  unit_name?: string
  brand?: string | null
  product_name?: string | null
  sku?: string | null
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
  const productId = String(body?.product_id || '').trim()
  const qty = Number(Math.max(0, toNumber(body?.qty)).toFixed(3))
  const suggestedQty = Number(Math.max(0, toNumber(body?.suggested_qty)).toFixed(3))
  const unitName = normalizeUnit(body?.unit_name || 'unidad')
  const snapshotBrand = normalizeBrand(body?.brand)
  const snapshotName = String(body?.product_name || '').trim() || null
  const snapshotSku = String(body?.sku || '').trim() || null

  if (!productId) {
    throw createError({ statusCode: 400, statusMessage: 'Producto obligatorio.' })
  }
  if (!Number.isFinite(qty) || qty <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'Cantidad inválida.' })
  }

  const quoteRes = await supabase
    .from('supplier_quotes')
    .select('id, status')
    .eq('id', quoteId)
    .single()

  if (quoteRes.error || !quoteRes.data?.id) {
    if (String(quoteRes.error?.code || '') === 'PGRST116') {
      throw createError({ statusCode: 404, statusMessage: 'Cotización no encontrada.' })
    }
    throw createError({ statusCode: 500, statusMessage: quoteRes.error?.message || 'No se pudo validar cotización.' })
  }

  if (String(quoteRes.data.status || '').trim().toLowerCase() !== 'draft') {
    throw createError({ statusCode: 400, statusMessage: 'Solo puedes agregar productos a una cotización abierta.' })
  }

  const duplicateRes = await supabase
    .from('supplier_quote_items')
    .select('id')
    .eq('quote_id', quoteId)
    .eq('product_id', productId)
    .limit(1)

  if (duplicateRes.error) {
    throw createError({ statusCode: 500, statusMessage: duplicateRes.error.message })
  }
  if ((duplicateRes.data || []).length) {
    throw createError({ statusCode: 409, statusMessage: 'Ese producto ya está en la cotización activa.' })
  }

  const productRes = await supabase
    .from('product_catalog')
    .select('id, name, sku, brand, unit, avg_cost, last_purchase_cost')
    .eq('id', productId)
    .single()

  if (productRes.error || !productRes.data?.id) {
    if (String(productRes.error?.code || '') === 'PGRST116') {
      throw createError({ statusCode: 404, statusMessage: 'Producto no encontrado en catálogo.' })
    }
    throw createError({ statusCode: 500, statusMessage: productRes.error?.message || 'No se pudo cargar producto.' })
  }

  const factorRes = await supabase
    .from('product_unit_conversions')
    .select('factor_to_base')
    .eq('product_id', productId)
    .eq('unit_name', unitName)
    .eq('is_active', true)
    .limit(1)

  if (factorRes.error) {
    throw createError({ statusCode: 500, statusMessage: factorRes.error.message })
  }

  const baseUnit = normalizeUnit((productRes.data as any)?.unit || 'unidad')
  const factor =
    unitName === baseUnit
      ? 1
      : Number((factorRes.data || [])[0]?.factor_to_base || 0) > 0
        ? Number((factorRes.data || [])[0]?.factor_to_base || 1)
        : 1

  const costUnit = Number(resolvePurchaseCost(productRes.data).toFixed(4))
  const lineTotal = Number((qty * factor * costUnit).toFixed(2))

  const insertRes = await supabase
    .from('supplier_quote_items')
    .insert({
      quote_id: quoteId,
      product_id: productId,
      qty,
      suggested_qty: suggestedQty,
      unit_name: unitName,
      cost_unit: costUnit,
      line_total: lineTotal,
      product_snapshot_brand: snapshotBrand ?? normalizeBrand((productRes.data as any)?.brand),
      product_snapshot_name: snapshotName ?? String((productRes.data as any)?.name || 'Producto'),
      product_snapshot_sku: snapshotSku ?? ((productRes.data as any)?.sku ? String((productRes.data as any).sku) : null)
    })
    .select('id')
    .single()

  if (insertRes.error || !insertRes.data?.id) {
    throw createError({ statusCode: 500, statusMessage: insertRes.error?.message || 'No se pudo agregar el producto.' })
  }

  const recalcRes = await supabase
    .from('supplier_quote_items')
    .select('product_id, qty, unit_name, line_total')
    .eq('quote_id', quoteId)

  if (recalcRes.error) {
    throw createError({ statusCode: 500, statusMessage: recalcRes.error.message })
  }

  const rows = recalcRes.data || []
  const productIds = Array.from(
    new Set(
      rows
        .map((row: any) => String(row?.product_id || '').trim())
        .filter((value: string) => Boolean(value))
    )
  )

  const factorByProductUnit = new Map<string, number>()
  if (productIds.length) {
    const conversionsRes = await supabase
      .from('product_unit_conversions')
      .select('product_id, unit_name, factor_to_base, is_active')
      .in('product_id', productIds)
      .eq('is_active', true)

    if (conversionsRes.error) {
      throw createError({ statusCode: 500, statusMessage: conversionsRes.error.message })
    }

    for (const row of conversionsRes.data || []) {
      const conversionProductId = String((row as any)?.product_id || '').trim()
      if (!conversionProductId) continue
      const conversionUnit = normalizeUnit((row as any)?.unit_name)
      const conversionFactor = Number((row as any)?.factor_to_base || 0)
      if (!Number.isFinite(conversionFactor) || conversionFactor <= 0) continue
      factorByProductUnit.set(`${conversionProductId}|${conversionUnit}`, conversionFactor)
    }
  }

  const factorFor = (rowProductId: string, rowUnitName: string) => {
    const key = `${String(rowProductId || '').trim()}|${normalizeUnit(rowUnitName)}`
    const rowFactor = Number(factorByProductUnit.get(key) || 0)
    return Number.isFinite(rowFactor) && rowFactor > 0 ? rowFactor : 1
  }

  const totalItems = rows.length
  const totalUnits = Number(
    rows
      .reduce((sum: number, row: any) => {
        const rowProductId = String(row?.product_id || '').trim()
        return sum + toNumber(row?.qty) * factorFor(rowProductId, row?.unit_name)
      }, 0)
      .toFixed(3)
  )
  const totalCost = Number(rows.reduce((sum: number, row: any) => sum + toNumber(row?.line_total), 0).toFixed(2))

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
    item_id: String(insertRes.data.id || ''),
    total_items: totalItems,
    total_units: totalUnits,
    total_cost: totalCost
  }
})
