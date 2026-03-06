import { defineEventHandler, getQuery, readBody, createError } from 'h3'
import { getSupabaseAdminClient } from '../../utils/supabase'

export default defineEventHandler(async (event) => {
  const supabase = getSupabaseAdminClient()
  const method = event.method

  if (method === 'GET') {
    const query = getQuery(event)
    if (!query.institution_id) throw createError({ statusCode: 400, statusMessage: 'institution_id requerido' })
    const { data, error } = await supabase
      .from('school_grades')
      .select('id, institution_id, level, name, sort_order, active')
      .eq('institution_id', query.institution_id)
      .order('sort_order')
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })
    return data
  }

  if (method === 'POST') {
    const body = await readBody(event)
    if (!body?.institution_id || !body?.name) throw createError({ statusCode: 400, statusMessage: 'institution_id y name son requeridos' })

    const payload = {
      institution_id: body.institution_id,
      name: String(body.name).trim(),
      level: body.level || 'primaria',
      sort_order: Number(body.sort_order) || 0,
      active: body.active !== false
    }

    if (body.id) {
      const { data, error } = await supabase.from('school_grades').update(payload).eq('id', body.id).select().single()
      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      return data
    } else {
      const { data, error } = await supabase.from('school_grades').insert(payload).select().single()
      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      return data
    }
  }

  throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
})
