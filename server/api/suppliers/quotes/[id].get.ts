import { createError, defineEventHandler, getRouterParam } from 'h3'

import { requireAccessToken } from '../../../utils/auth'
import { getSupabaseUserClient } from '../../../utils/supabase'

const normalizeUnit = (value: unknown) =>
  String(value || '')
    .trim()
    .toLowerCase() || 'unidad'

const toNumber = (value: unknown) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

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

  const id = String(getRouterParam(event, 'id') || '').trim()
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'Cotización inválida.' })
  }

  const quoteRes = await supabase
    .from('supplier_quotes')
    .select('id, supplier_id, min_required_units, status, notes, total_items, total_units, total_cost, created_at, suppliers(name)')
    .eq('id', id)
    .single()

  if (quoteRes.error || !quoteRes.data) {
    if (String(quoteRes.error?.code || '') === '42P01') {
      throw createError({
        statusCode: 500,
        statusMessage: 'No existe la tabla de cotizaciones. Ejecuta la migración de supplier quotes.'
      })
    }
    if (String(quoteRes.error?.code || '') === 'PGRST116') {
      throw createError({ statusCode: 404, statusMessage: 'Cotización no encontrada.' })
    }
    throw createError({ statusCode: 500, statusMessage: quoteRes.error?.message || 'No se pudo cargar cotización.' })
  }

  const itemsRes = await supabase
    .from('supplier_quote_items')
    .select(
      'id, quote_id, product_id, qty, suggested_qty, unit_name, cost_unit, line_total, product_snapshot_brand, product_snapshot_name, product_snapshot_sku, created_at'
    )
    .eq('quote_id', id)
    .order('created_at', { ascending: true })

  if (itemsRes.error) {
    if (String(itemsRes.error.code || '') === '42P01') {
      throw createError({
        statusCode: 500,
        statusMessage: 'No existe la tabla de detalle de cotizaciones. Ejecuta la migración de supplier quotes.'
      })
    }
    throw createError({ statusCode: 500, statusMessage: itemsRes.error.message })
  }

  const rows = Array.isArray(itemsRes.data) ? itemsRes.data : []
  const productIds = rows
    .map((row: any) => String(row?.product_id || '').trim())
    .filter((value: string) => Boolean(value))

  const productById = new Map<string, any>()
  const conversionsByProduct = new Map<string, Array<{ unit_name: string; factor_to_base: number }>>()
  if (productIds.length) {
    const productsRes = await supabase
      .from('product_catalog')
      .select('id, sku, name, brand, product_type, unit, stock_on_hand, avg_cost, last_purchase_cost')
      .in('id', productIds)

    if (productsRes.error) {
      throw createError({ statusCode: 500, statusMessage: productsRes.error.message })
    }

    for (const row of productsRes.data || []) {
      const productId = String((row as any)?.id || '').trim()
      if (!productId) continue
      productById.set(productId, row)
    }

    const convRes = await supabase
      .from('product_unit_conversions')
      .select('product_id, unit_name, factor_to_base, is_active')
      .in('product_id', productIds)
      .eq('is_active', true)

    if (convRes.error) {
      throw createError({ statusCode: 500, statusMessage: convRes.error.message })
    }

    for (const row of convRes.data || []) {
      const productId = String((row as any)?.product_id || '').trim()
      if (!productId) continue

      const unitName = normalizeUnit((row as any)?.unit_name)
      const factor = Number((row as any)?.factor_to_base || 0)
      if (!Number.isFinite(factor) || factor <= 0) continue

      const list = conversionsByProduct.get(productId) || []
      list.push({ unit_name: unitName, factor_to_base: factor })
      conversionsByProduct.set(productId, list)
    }
  }

  const items = rows
    .map((row: any) => {
      const productId = String(row?.product_id || '')
      const current = productById.get(productId) || {}
      const baseUnit = normalizeUnit(current?.unit || 'unidad')
      const currentUnit = normalizeUnit(row?.unit_name || baseUnit)
      const converted = conversionsByProduct.get(productId) || []
      const currentPurchaseCost = Number(resolvePurchaseCost(current).toFixed(4))
      const quoteCost = Number(row?.cost_unit || 0)
      const unitCost = currentPurchaseCost > 0 ? currentPurchaseCost : quoteCost
      const snapshotBrand = normalizeBrand(row?.product_snapshot_brand)
      const currentBrand = normalizeBrand(current?.brand)

      const optionsMap = new Map<string, { unit_name: string; factor_to_base: number }>()
      optionsMap.set(baseUnit, { unit_name: baseUnit, factor_to_base: 1 })
      for (const option of converted) {
        optionsMap.set(option.unit_name, option)
      }
      if (!optionsMap.has(currentUnit)) {
        optionsMap.set(currentUnit, { unit_name: currentUnit, factor_to_base: 1 })
      }

      const presentationOptions = Array.from(optionsMap.values()).sort((a, b) => {
        if (a.factor_to_base !== b.factor_to_base) {
          return a.factor_to_base - b.factor_to_base
        }
        return a.unit_name.localeCompare(b.unit_name)
      })

      return {
        id: String(row?.id || ''),
        product_id: productId,
        name: String(current?.name || row?.product_snapshot_name || 'Producto'),
        brand: snapshotBrand ?? currentBrand,
        sku: current?.sku || row?.product_snapshot_sku || null,
        category: current?.product_type || null,
        base_unit: baseUnit,
        unit_name: currentUnit,
        presentation_options: presentationOptions,
        qty: Number(row?.qty || 0),
        suggested_qty: Number(row?.suggested_qty || 0),
        cost_unit: unitCost,
        line_total: Number(row?.line_total || 0),
        stock_on_hand: Number(current?.stock_on_hand || 0)
      }
    })
    .sort((a, b) => {
      const nameOrder = a.name.localeCompare(b.name, 'es', { sensitivity: 'base' })
      if (nameOrder !== 0) return nameOrder
      return String(a.sku || '').localeCompare(String(b.sku || ''), 'es', { sensitivity: 'base' })
    })

  return {
    quote: {
      id: String(quoteRes.data.id || ''),
      supplier_id: String(quoteRes.data.supplier_id || ''),
      supplier_name: String((quoteRes.data.suppliers as any)?.name || 'Sin proveedor'),
      min_required_units: Number(quoteRes.data.min_required_units || 0),
      status: String(quoteRes.data.status || 'draft'),
      notes: quoteRes.data.notes ? String(quoteRes.data.notes) : null,
      total_items: Number(quoteRes.data.total_items || 0),
      total_units: Number(quoteRes.data.total_units || 0),
      total_cost: Number(quoteRes.data.total_cost || 0),
      created_at: String(quoteRes.data.created_at || '')
    },
    items
  }
})
