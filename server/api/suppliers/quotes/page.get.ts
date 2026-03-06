import { createError, defineEventHandler } from 'h3'

import { requireAccessToken } from '../../../utils/auth'
import { getSupabaseUserClient } from '../../../utils/supabase'

export default defineEventHandler(async (event) => {
  const accessToken = await requireAccessToken(event)
  const supabase = getSupabaseUserClient(accessToken)

  const res = await supabase
    .from('supplier_quotes')
    .select('id, supplier_id, min_required_units, status, notes, total_items, total_units, total_cost, created_at, suppliers(name)')
    .order('created_at', { ascending: false })
    .limit(300)

  if (res.error) {
    if (String(res.error.code || '') === '42P01') {
      throw createError({
        statusCode: 500,
        statusMessage: 'No existe la tabla de cotizaciones. Ejecuta la migración de supplier quotes.'
      })
    }
    throw createError({ statusCode: 500, statusMessage: res.error.message })
  }

  const quotes = (res.data || []).map((row: any) => ({
    id: String(row?.id || ''),
    supplier_id: String(row?.supplier_id || ''),
    supplier_name: String((row?.suppliers as any)?.name || 'Sin proveedor'),
    min_required_units: Number(row?.min_required_units || 0),
    status: String(row?.status || 'draft'),
    notes: row?.notes ? String(row.notes) : null,
    total_items: Number(row?.total_items || 0),
    total_units: Number(row?.total_units || 0),
    total_cost: Number(row?.total_cost || 0),
    created_at: String(row?.created_at || '')
  }))

  const nonCancelled = quotes.filter((row) => row.status !== 'cancelled')
  const draftRows = nonCancelled.filter((row) => row.status === 'draft')

  if (draftRows.length <= 1) {
    return { quotes: nonCancelled }
  }

  const latestDraftId = draftRows
    .slice()
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0]?.id

  return {
    quotes: nonCancelled.filter((row) => row.status !== 'draft' || row.id === latestDraftId)
  }
})
