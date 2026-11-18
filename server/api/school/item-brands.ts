import { defineEventHandler, getQuery, readBody, createError } from 'h3'
import { getSupabaseAdminClient } from '../../utils/supabase'

export default defineEventHandler(async (event) => {
  const supabase = getSupabaseAdminClient()
  const method = event.method

  // GET: list brands for an item
  if (method === 'GET') {
    const query = getQuery(event)
    if (!query.item_id) throw createError({ statusCode: 400, statusMessage: 'item_id requerido' })
    const { data, error } = await supabase
      .from('school_list_item_brands')
      .select(
        'id, item_id, brand, is_default, product_id, pricing_rule_id, pricing_unit_name, pricing_label, pricing_price_uom, pricing_factor_to_base, products(name, sale_price)'
      )
      .eq('item_id', query.item_id)
      .order('brand')
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })
    return (data || []).map((b: any) => ({
      id: b.id,
      item_id: b.item_id,
      brand: b.brand,
      is_default: b.is_default,
      product_id: b.product_id,
      product_name: b.products?.name || null,
      pricing_rule_id: b.pricing_rule_id || null,
      pricing_unit_name: b.pricing_unit_name || null,
      pricing_label: b.pricing_label || null,
      pricing_price_uom: b.pricing_price_uom,
      pricing_factor_to_base: b.pricing_factor_to_base,
    }))
  }

  // POST: create brand variant
  if (method === 'POST') {
    const body = await readBody(event)
    if (!body?.item_id || !body?.product_id || !body?.brand) {
      throw createError({ statusCode: 400, statusMessage: 'item_id, product_id y brand son requeridos' })
    }
    const payload: Record<string, any> = {
      item_id: body.item_id,
      product_id: body.product_id,
      brand: String(body.brand).trim(),
    }
    if (typeof body.is_default === 'boolean') {
      payload.is_default = body.is_default
    }
    if (typeof body.pricing_rule_id !== 'undefined') {
      payload.pricing_rule_id = body.pricing_rule_id || null
    }
    if (typeof body.pricing_unit_name !== 'undefined') {
      payload.pricing_unit_name = body.pricing_unit_name || null
    }
    if (typeof body.pricing_label !== 'undefined') {
      payload.pricing_label = body.pricing_label || null
    }
    if (typeof body.pricing_price_uom !== 'undefined') {
      payload.pricing_price_uom =
        body.pricing_price_uom === null || body.pricing_price_uom === ''
          ? null
          : Number(body.pricing_price_uom || 0)
    }
    if (typeof body.pricing_factor_to_base !== 'undefined') {
      payload.pricing_factor_to_base =
        body.pricing_factor_to_base === null || body.pricing_factor_to_base === ''
          ? null
          : Number(body.pricing_factor_to_base || 0)
    }

    if (body.id) {
      const { data, error } = await supabase
        .from('school_list_item_brands')
        .update(payload)
        .eq('id', body.id)
        .select()
        .single()
      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      if (payload.is_default === true) {
        const { error: resetError } = await supabase
          .from('school_list_item_brands')
          .update({ is_default: false })
          .eq('item_id', body.item_id)
          .neq('id', data.id)
        if (resetError) throw createError({ statusCode: 500, statusMessage: resetError.message })
      }
      return data
    } else {
      const { data, error } = await supabase
        .from('school_list_item_brands')
        .insert(payload)
        .select()
        .single()
      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      if (payload.is_default === true) {
        const { error: resetError } = await supabase
          .from('school_list_item_brands')
          .update({ is_default: false })
          .eq('item_id', body.item_id)
          .neq('id', data.id)
        if (resetError) throw createError({ statusCode: 500, statusMessage: resetError.message })
      }
      return data
    }
  }

  // DELETE: remove brand variant(s)
  // ?id=xxx       → borra una marca específica
  // ?item_id=xxx  → borra TODAS las marcas de un ítem (reemplazo completo)
  if (method === 'DELETE') {
    const query = getQuery(event)
    if (query.item_id) {
      const { error } = await supabase
        .from('school_list_item_brands')
        .delete()
        .eq('item_id', query.item_id)
      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      return { success: true }
    }
    if (!query.id) throw createError({ statusCode: 400, statusMessage: 'id o item_id requerido' })
    const { error } = await supabase.from('school_list_item_brands').delete().eq('id', query.id)
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })
    return { success: true }
  }

  throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
})
