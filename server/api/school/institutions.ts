import { defineEventHandler, getQuery, readBody, createError } from 'h3'
import { getSupabaseAdminClient } from '../../utils/supabase'

export default defineEventHandler(async (event) => {
  const supabase = getSupabaseAdminClient()
  const method = event.method

  if (method === 'GET') {
    const { data, error } = await supabase
      .from('institutions')
      .select('id, name, short_name, active')
      .order('name')
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })
    return data
  }

  if (method === 'POST') {
    const body = await readBody(event)
    if (!body?.name) throw createError({ statusCode: 400, statusMessage: 'Nombre es requerido' })

    const payload = {
      name: String(body.name).trim(),
      short_name: body.short_name ? String(body.short_name).trim() : null,
      active: body.active !== false
    }

    if (body.id) {
      const { data, error } = await supabase.from('institutions').update(payload).eq('id', body.id).select().single()
      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      return data
    } else {
      const { data, error } = await supabase.from('institutions').insert(payload).select().single()
      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      return data
    }
  }

  throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
})
