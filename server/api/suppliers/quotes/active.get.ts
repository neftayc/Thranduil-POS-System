import { createError, defineEventHandler } from 'h3'

import { requireAccessToken } from '../../../utils/auth'
import { getSupabaseUserClient } from '../../../utils/supabase'

const normalizeUnit = (value: unknown) =>
  String(value || '')
    .trim()
    .toLowerCase() || 'unidad'

const normalizeBrand = (value: unknown) => {
  const raw = String(value ?? '').trim()
  return raw ? raw : null
}

export default defineEventHandler(async (event) => {
  const accessToken = await requireAccessToken(event)
  const supabase = getSupabaseUserClient(accessToken)

  const quoteRes = await supabase
    .from('supplier_quotes')
    .select('id, supplier_id, min_required_units, status, notes, total_items, total_units, total_cost, created_at, updated_at')
    .eq('status', 'draft')
    .order('updated_at', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1)

  if (quoteRes.error) {
    if (String(quoteRes.error.code || '') === '42P01') {
      throw createError({
        statusCode: 500,
        statusMessage: 'No existe la tabla de cotizaciones. Ejecuta la migración de supplier quotes.'
      })
    }
    throw createError({ statusCode: 500, statusMessage: quoteRes.error.message })
  }

  const active = Array.isArray(quoteRes.data) && quoteRes.data.length ? (quoteRes.data[0] as any) : null
  if (!active?.id) {
    return { quote: null, items: [] }
  }

  const quoteId = String(active.id)
  const itemsRes = await supabase
    .from('supplier_quote_items')
    .select(
      'id, product_id, qty, suggested_qty, unit_name, cost_unit, product_snapshot_brand, product_snapshot_name, product_snapshot_sku, created_at'
    )
    .eq('quote_id', quoteId)
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

  return {
    quote: {
      id: quoteId,
      supplier_id: String(active.supplier_id || ''),
      min_required_units: Number(active.min_required_units || 0),
      status: String(active.status || 'draft'),
      notes: active.notes ? String(active.notes) : null,
      total_items: Number(active.total_items || 0),
      total_units: Number(active.total_units || 0),
      total_cost: Number(active.total_cost || 0),
      created_at: String(active.created_at || ''),
      updated_at: String(active.updated_at || '')
    },
    items: (itemsRes.data || []).map((row: any) => ({
      id: String(row?.id || ''),
      product_id: String(row?.product_id || ''),
      qty: Number(row?.qty || 0),
      suggested_qty: Number(row?.suggested_qty || 0),
      unit_name: normalizeUnit(row?.unit_name),
      cost_unit: Number(row?.cost_unit || 0),
      brand: normalizeBrand(row?.product_snapshot_brand),
      product_name: row?.product_snapshot_name ? String(row.product_snapshot_name) : null,
      sku: row?.product_snapshot_sku ? String(row.product_snapshot_sku) : null
    }))
  }
})
