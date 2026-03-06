import { defineEventHandler, getQuery, readBody, createError } from 'h3'
import { getSupabaseAdminClient } from '../../utils/supabase'

export default defineEventHandler(async (event) => {
  const supabase = getSupabaseAdminClient()
  const method = event.method

  // POST: create or update item
  if (method === 'POST') {
    const body = await readBody(event)
    if (!body?.list_id || !body?.item_description) {
      throw createError({ statusCode: 400, statusMessage: 'list_id e item_description son requeridos' })
    }
    const payload = {
      list_id: body.list_id,
      item_description: String(body.item_description).trim(),
      qty: Number(body.qty) || 1,
      notes: body.notes || null,
      sort_order: Number(body.sort_order) || 0
    }
    if (body.id) {
      const { data, error } = await supabase.from('school_list_items').update(payload).eq('id', body.id).select().single()
      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      return data
    } else {
      const { data, error } = await supabase.from('school_list_items').insert(payload).select().single()
      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      return data
    }
  }

  // DELETE: remove item
  if (method === 'DELETE') {
    const query = getQuery(event)
    if (!query.id) throw createError({ statusCode: 400, statusMessage: 'id requerido' })
    const { error } = await supabase.from('school_list_items').delete().eq('id', query.id)
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })
    return { success: true }
  }

  throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
})
