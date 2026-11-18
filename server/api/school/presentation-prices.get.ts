import { createError, defineEventHandler, getQuery } from 'h3'

import { getSupabaseAdminClient } from '../../utils/supabase'

const isActiveNow = (startsAt: string | null, endsAt: string | null) => {
  const now = Date.now()
  if (startsAt) {
    const starts = new Date(startsAt).getTime()
    if (Number.isFinite(starts) && starts > now) return false
  }
  if (endsAt) {
    const ends = new Date(endsAt).getTime()
    if (Number.isFinite(ends) && ends < now) return false
  }
  return true
}

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const productId = String(query.product_id || '').trim()
  if (!productId) {
    throw createError({ statusCode: 400, statusMessage: 'product_id requerido' })
  }

  const supabase = getSupabaseAdminClient()

  const [{ data: product, error: productError }, { data: rules, error: rulesError }, { data: conversions, error: conversionsError }, { data: units, error: unitsError }] =
    await Promise.all([
      supabase
        .from('product_catalog')
        .select('id, name, unit, sale_price')
        .eq('id', productId)
        .single(),
      supabase
        .from('product_presentation_prices')
        .select('id, unit_name, customer_group, price_uom, starts_at, ends_at, priority, active')
        .eq('product_id', productId)
        .eq('active', true)
        .order('priority')
        .order('created_at', { ascending: false }),
      supabase
        .from('product_unit_conversions')
        .select('unit_name, factor_to_base')
        .eq('product_id', productId)
        .eq('is_active', true),
      supabase.from('uom_catalog').select('code, label').eq('active', true),
    ])

  if (productError || !product) {
    throw createError({ statusCode: 404, statusMessage: productError?.message || 'Producto no encontrado' })
  }
  if (rulesError) throw createError({ statusCode: 500, statusMessage: rulesError.message })
  if (conversionsError) throw createError({ statusCode: 500, statusMessage: conversionsError.message })
  if (unitsError) throw createError({ statusCode: 500, statusMessage: unitsError.message })

  const unitLabelByCode = new Map<string, string>()
  for (const row of units || []) {
    const code = String((row as any)?.code || '').trim()
    if (!code) continue
    unitLabelByCode.set(code, String((row as any)?.label || code).trim() || code)
  }

  const factorByUnit = new Map<string, number>()
  factorByUnit.set(String(product.unit || '').trim() || 'unidad', 1)
  for (const row of conversions || []) {
    const unitName = String((row as any)?.unit_name || '').trim()
    const factor = Number((row as any)?.factor_to_base || 0)
    if (!unitName || !Number.isFinite(factor) || factor <= 0) continue
    factorByUnit.set(unitName, factor)
  }

  const baseUnit = String(product.unit || '').trim() || 'unidad'
  const baseLabel = unitLabelByCode.get(baseUnit) || baseUnit

  const options = [
    {
      key: 'base',
      rule_id: null,
      unit_name: baseUnit,
      factor_to_base: 1,
      price_uom: Number(product.sale_price || 0),
      label: `Base (${baseLabel})`,
      helper: null,
    },
  ]

  for (const rule of rules || []) {
    const unitName = String((rule as any)?.unit_name || '').trim()
    const factorToBase = Number(factorByUnit.get(unitName) || 0)
    if (!unitName || !Number.isFinite(factorToBase) || factorToBase <= 0) continue
    if (!isActiveNow((rule as any)?.starts_at || null, (rule as any)?.ends_at || null)) continue

    const unitLabel = unitLabelByCode.get(unitName) || unitName
    const customerGroup = String((rule as any)?.customer_group || '').trim()
    const groupSuffix = customerGroup ? ` · ${customerGroup}` : ''

    options.push({
      key: `presentation:${String((rule as any)?.id || '').trim()}`,
      rule_id: (rule as any)?.id || null,
      unit_name: unitName,
      factor_to_base: Number.isFinite(factorToBase) && factorToBase > 0 ? factorToBase : null,
      price_uom: Number((rule as any)?.price_uom || 0),
      label: `Presentacion (${unitLabel})${groupSuffix}`,
      helper:
        Number.isFinite(factorToBase) && factorToBase > 0
          ? factorToBase > 1
            ? `Equivale a ${factorToBase} base`
            : null
          : 'Falta conversion para esta presentacion',
    })
  }

  return {
    product: {
      id: product.id,
      name: product.name,
      unit: baseUnit,
      sale_price: Number(product.sale_price || 0),
    },
    options,
  }
})
