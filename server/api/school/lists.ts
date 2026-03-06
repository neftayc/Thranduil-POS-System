import { defineEventHandler, getQuery, readBody, createError } from 'h3'
import { getSupabaseAdminClient } from '../../utils/supabase'

export default defineEventHandler(async (event) => {
  const supabase = getSupabaseAdminClient()
  const method = event.method

  // GET: fetch list header + items for admin
  if (method === 'GET') {
    const query = getQuery(event)
    if (!query.institution_id || !query.grade_id || !query.section_id) {
      throw createError({ statusCode: 400, statusMessage: 'institution_id, grade_id, section_id requeridos' })
    }

    let q = supabase
      .from('school_lists')
      .select('*')
      .eq('institution_id', query.institution_id)
      .eq('grade_id', query.grade_id)
      .eq('section_id', query.section_id)
      .order('year', { ascending: false })
      .limit(1)

    if (query.year) q = q.eq('year', Number(query.year))

    const { data: listData } = await q.single()

    if (!listData) return { list: null, items: [] }

    const { data: items } = await supabase
      .from('school_list_items')
      .select('*')
      .eq('list_id', listData.id)
      .order('sort_order')

    return { list: listData, items: items || [] }
  }

  // POST: create new list
  if (method === 'POST') {
    const body = await readBody(event)
    if (!body?.institution_id || !body?.grade_id || !body?.section_id) {
      throw createError({ statusCode: 400, statusMessage: 'Campos requeridos faltantes' })
    }
    const payload = {
      institution_id: body.institution_id,
      grade_id: body.grade_id,
      section_id: body.section_id,
      year: Number(body.year) || new Date().getFullYear(),
      active: body.active !== false,
      notes: body.notes || null
    }
    const { data, error } = await supabase.from('school_lists').insert(payload).select().single()
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })
    return data
  }

  // PATCH: update active status
  if (method === 'PATCH') {
    const body = await readBody(event)
    if (!body?.id) throw createError({ statusCode: 400, statusMessage: 'id requerido' })
    const { data, error } = await supabase
      .from('school_lists')
      .update({ active: body.active })
      .eq('id', body.id)
      .select()
      .single()
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })
    return data
  }

  throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
})
