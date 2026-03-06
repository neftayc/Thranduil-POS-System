import { defineEventHandler, getQuery, readBody, createError } from 'h3'
import { getSupabaseAdminClient } from '../../utils/supabase'

export default defineEventHandler(async (event) => {
  const supabase = getSupabaseAdminClient()
  const method = event.method

  if (method === 'GET') {
    const query = getQuery(event)
    if (!query.grade_id) throw createError({ statusCode: 400, statusMessage: 'grade_id requerido' })
    const { data, error } = await supabase
      .from('school_sections')
      .select('id, grade_id, name, active')
      .eq('grade_id', query.grade_id)
      .order('name')
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })
    return data
  }

  if (method === 'POST') {
    const body = await readBody(event)
    if (!body?.grade_id || !body?.name) throw createError({ statusCode: 400, statusMessage: 'grade_id y name son requeridos' })

    const payload = {
      grade_id: body.grade_id,
      name: String(body.name).trim().toUpperCase(),
      active: body.active !== false
    }

    if (body.id) {
      const { data, error } = await supabase.from('school_sections').update(payload).eq('id', body.id).select().single()
      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      return data
    } else {
      const { data, error } = await supabase.from('school_sections').insert(payload).select().single()
      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      return data
    }
  }

  throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
})
