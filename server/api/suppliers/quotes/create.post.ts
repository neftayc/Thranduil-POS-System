import { createError, defineEventHandler, readBody } from 'h3'

import { requireAccessToken } from '../../../utils/auth'
import { getSupabaseUserClient } from '../../../utils/supabase'

type QuoteItemInput = {
  product_id?: string
  qty?: number
  unit_name?: string
  cost_unit?: number
  brand?: string | null
  suggested_qty?: number
  product_name?: string | null
  sku?: string | null
}

type Body = {
  supplier_id?: string | null
  min_required_units?: number
  notes?: string | null
  items?: QuoteItemInput[]
}

const clampInt = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

const toNumber = (value: unknown, fallback = 0) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const normalizeBrand = (value: unknown) => {
  const raw = String(value ?? '').trim()
  return raw ? raw : null
}

const resolvePurchaseCost = (product: any) => {
  const lastPurchaseCost = Math.max(0, toNumber(product?.last_purchase_cost, 0))
  if (lastPurchaseCost > 0) return lastPurchaseCost
  return Math.max(0, toNumber(product?.avg_cost, 0))
}

export default defineEventHandler(async (event) => {
  const accessToken = await requireAccessToken(event)
  const supabase = getSupabaseUserClient(accessToken)
  const body = (await readBody(event)) as Body

  const supplierId = String(body?.supplier_id || '').trim()
  const minRequiredUnits = clampInt(body?.min_required_units, 12, 1, 5000)
  const notes = String(body?.notes || '').trim()
  const rawItems = Array.isArray(body?.items) ? body.items : []

  if (!supplierId) {
    throw createError({ statusCode: 400, statusMessage: 'Proveedor obligatorio para guardar cotización.' })
  }

  const items = rawItems
    .map((item) => {
      const productId = String(item?.product_id || '').trim()
      const qty = Math.max(0, Number(toNumber(item?.qty, 0).toFixed(3)))
      const suggestedQty = Math.max(0, Number(toNumber(item?.suggested_qty, 0).toFixed(3)))
      const unitName = String(item?.unit_name || 'unidad').trim().toLowerCase() || 'unidad'
      const brand = normalizeBrand(item?.brand)
      const productName = String(item?.product_name || '').trim()
      const sku = String(item?.sku || '').trim()

      if (!productId || qty <= 0) return null

      return {
        product_id: productId,
        qty,
        unit_name: unitName,
        cost_unit: 0,
        line_total: 0,
        suggested_qty: suggestedQty,
        product_snapshot_brand: brand,
        product_snapshot_name: productName || null,
        product_snapshot_sku: sku || null
      }
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))

  if (!items.length) {
    throw createError({ statusCode: 400, statusMessage: 'Selecciona al menos un producto para cotizar.' })
  }

  const productIds = Array.from(new Set(items.map((item) => item.product_id)))
  const factorByProductUnit = new Map<string, number>()
  const purchaseCostByProduct = new Map<string, number>()
  const brandByProduct = new Map<string, string | null>()

  if (productIds.length) {
    const [convRes, productsRes] = await Promise.all([
      supabase
        .from('product_unit_conversions')
        .select('product_id, unit_name, factor_to_base, is_active')
        .in('product_id', productIds)
        .eq('is_active', true),
      supabase
        .from('product_catalog')
        .select('id, brand, avg_cost, last_purchase_cost')
        .in('id', productIds)
    ])

    if (convRes.error) {
      throw createError({ statusCode: 500, statusMessage: convRes.error.message })
    }
    if (productsRes.error) {
      throw createError({ statusCode: 500, statusMessage: productsRes.error.message })
    }

    for (const row of convRes.data || []) {
      const productId = String((row as any)?.product_id || '').trim()
      if (!productId) continue
      const unitName = String((row as any)?.unit_name || '').trim().toLowerCase() || 'unidad'
      const factor = Number((row as any)?.factor_to_base || 0)
      if (!Number.isFinite(factor) || factor <= 0) continue
      factorByProductUnit.set(`${productId}|${unitName}`, factor)
    }

    for (const row of productsRes.data || []) {
      const productId = String((row as any)?.id || '').trim()
      if (!productId) continue
      purchaseCostByProduct.set(productId, Number(resolvePurchaseCost(row).toFixed(4)))
      brandByProduct.set(productId, normalizeBrand((row as any)?.brand))
    }
  }

  const factorFor = (productId: string, unitName: string) => {
    const key = `${String(productId || '').trim()}|${String(unitName || '').trim().toLowerCase() || 'unidad'}`
    const factor = Number(factorByProductUnit.get(key) || 0)
    return Number.isFinite(factor) && factor > 0 ? factor : 1
  }

  items.forEach((item) => {
    const purchaseCost = Number(purchaseCostByProduct.get(item.product_id) || 0)
    item.cost_unit = Number(Math.max(0, purchaseCost).toFixed(4))
    if (!item.product_snapshot_brand) {
      item.product_snapshot_brand = brandByProduct.get(item.product_id) || null
    }
    const factorToBase = factorFor(item.product_id, item.unit_name)
    item.line_total = Number((item.qty * factorToBase * item.cost_unit).toFixed(2))
  })

  const totalItems = items.length
  const totalUnits = Number(
    items
      .reduce((sum, item) => {
        const factorToBase = factorFor(item.product_id, item.unit_name)
        return sum + item.qty * factorToBase
      }, 0)
      .toFixed(3)
  )
  const totalCost = Number(items.reduce((sum, item) => sum + item.line_total, 0).toFixed(2))

  const activeDraftRes = await supabase
    .from('supplier_quotes')
    .select('id')
    .eq('status', 'draft')
    .order('updated_at', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1)

  if (activeDraftRes.error) {
    if (String(activeDraftRes.error.code || '') === '42P01') {
      throw createError({
        statusCode: 500,
        statusMessage: 'No existe la tabla de cotizaciones. Ejecuta la migración de supplier quotes.'
      })
    }
    throw createError({ statusCode: 500, statusMessage: activeDraftRes.error.message })
  }

  let quoteId = ''
  let createdNewQuote = false
  const activeDraft = Array.isArray(activeDraftRes.data) && activeDraftRes.data.length
    ? (activeDraftRes.data[0] as any)
    : null

  if (activeDraft?.id) {
    quoteId = String(activeDraft.id)
    const quoteUpdateRes = await supabase
      .from('supplier_quotes')
      .update({
        supplier_id: supplierId,
        min_required_units: minRequiredUnits,
        notes: notes || null,
        status: 'draft',
        total_items: totalItems,
        total_units: totalUnits,
        total_cost: totalCost,
        updated_at: new Date().toISOString()
      })
      .eq('id', quoteId)

    if (quoteUpdateRes.error) {
      throw createError({ statusCode: 500, statusMessage: quoteUpdateRes.error.message })
    }

    const clearItemsRes = await supabase
      .from('supplier_quote_items')
      .delete()
      .eq('quote_id', quoteId)

    if (clearItemsRes.error) {
      throw createError({ statusCode: 500, statusMessage: clearItemsRes.error.message })
    }
  } else {
    const quoteRes = await supabase
      .from('supplier_quotes')
      .insert({
        supplier_id: supplierId,
        min_required_units: minRequiredUnits,
        notes: notes || null,
        status: 'draft',
        total_items: totalItems,
        total_units: totalUnits,
        total_cost: totalCost
      })
      .select('id')
      .single()

    if (quoteRes.error || !quoteRes.data?.id) {
      if (String(quoteRes.error?.code || '') === '42P01') {
        throw createError({
          statusCode: 500,
          statusMessage: 'No existe la tabla de cotizaciones. Ejecuta la migración de supplier quotes.'
        })
      }
      throw createError({ statusCode: 500, statusMessage: quoteRes.error?.message || 'No se pudo crear la cotización.' })
    }

    quoteId = String(quoteRes.data.id)
    createdNewQuote = true
  }

  const itemRes = await supabase.from('supplier_quote_items').insert(
    items.map((item) => ({
      quote_id: quoteId,
      ...item
    }))
  )

  if (itemRes.error) {
    if (createdNewQuote) {
      await supabase.from('supplier_quotes').delete().eq('id', quoteId)
    }

    if (String(itemRes.error.code || '') === '42P01') {
      throw createError({
        statusCode: 500,
        statusMessage: 'No existe la tabla de detalle de cotizaciones. Ejecuta la migración de supplier quotes.'
      })
    }

    throw createError({ statusCode: 500, statusMessage: itemRes.error.message })
  }

  return {
    ok: true,
    quote_id: quoteId,
    total_items: totalItems,
    total_units: totalUnits,
    total_cost: totalCost
  }
})
