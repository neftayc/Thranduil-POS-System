import { createError, defineEventHandler } from 'h3'

import { getUserIdFromAccessToken, requireAccessToken } from '../../utils/auth'
import { getSupabaseUserClient } from '../../utils/supabase'

export default defineEventHandler(async (event) => {
  const accessToken = await requireAccessToken(event)
  const userId = await getUserIdFromAccessToken(event)
  const supabase = getSupabaseUserClient(accessToken)

  const { data, error } = await supabase
    .from('combo_workspaces')
    .select('combos, updated_at')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) {
    throw createError({ statusCode: 500, statusMessage: error.message })
  }

  return {
    combos: Array.isArray(data?.combos) ? data.combos : null,
    updated_at: data?.updated_at || null,
  }
})
