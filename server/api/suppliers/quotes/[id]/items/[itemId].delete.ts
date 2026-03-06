import { createError, defineEventHandler, getRouterParam } from 'h3'

import { requireAccessToken } from '../../../../../utils/auth'
import { getSupabaseUserClient } from '../../../../../utils/supabase'

const toNumber = (value: unknown) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const normalizeUnit = (value: unknown) =>
  String(value || '')
    .trim()
    .toLowerCase() || 'unidad'

export default defineEventHandler(async (event) => {
  const accessToken = await requireAccessToken(event)
  const supabase = getSupabaseUserClient(accessToken)

  const quoteId = String(getRouterParam(event, 'id') || '').trim()
  const itemId = String(getRouterParam(event, 'itemId') || '').trim()
  if (!quoteId || !itemId) {
    throw createError({ statusCode: 400, statusMessage: 'Parámetros inválidos.' })
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
    throw createError({ statusCode: 400, statusMessage: 'Solo puedes editar una cotización abierta.' })
  }

  const existingRes = await supabase
    .from('supplier_quote_items')
    .select('id')
    .eq('quote_id', quoteId)
    .eq('id', itemId)
    .single()

  if (existingRes.error || !existingRes.data?.id) {
    if (String(existingRes.error?.code || '') === 'PGRST116') {
      throw createError({ statusCode: 404, statusMessage: 'Ítem de cotización no encontrado.' })
    }
    throw createError({ statusCode: 500, statusMessage: existingRes.error?.message || 'No se pudo validar el ítem.' })
  }

  const deleteRes = await supabase
    .from('supplier_quote_items')
    .delete()
    .eq('quote_id', quoteId)
    .eq('id', itemId)

  if (deleteRes.error) {
    throw createError({ statusCode: 500, statusMessage: deleteRes.error.message })
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
    total_items: totalItems,
    total_units: totalUnits,
    total_cost: totalCost
  }
})
