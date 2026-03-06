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
      .select('id, item_id, brand, is_default, product_id, products(name, sale_price)')
      .eq('item_id', query.item_id)
      .order('brand')
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })
    return (data || []).map((b: any) => ({
      id: b.id,
      item_id: b.item_id,
      brand: b.brand,
      is_default: b.is_default,
      product_id: b.product_id,
      product_name: b.products?.name || null
    }))
  }

  // POST: create brand variant
  if (method === 'POST') {
    const body = await readBody(event)
    if (!body?.item_id || !body?.product_id || !body?.brand) {
      throw createError({ statusCode: 400, statusMessage: 'item_id, product_id y brand son requeridos' })
    }
    const payload = {
      item_id: body.item_id,
      product_id: body.product_id,
      brand: String(body.brand).trim(),
    }

    if (body.id) {
      const { data, error } = await supabase.from('school_list_item_brands').update(payload).eq('id', body.id).select().single()
      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      return data
    } else {
      const { data, error } = await supabase.from('school_list_item_brands').insert(payload).select().single()
      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
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
