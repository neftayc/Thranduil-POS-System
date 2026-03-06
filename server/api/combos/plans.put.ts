import { createError, defineEventHandler, readBody } from 'h3'

import { getUserIdFromAccessToken, requireAccessToken } from '../../utils/auth'
import { getSupabaseUserClient } from '../../utils/supabase'

type Body = {
  combos?: unknown
}

export default defineEventHandler(async (event) => {
  const accessToken = await requireAccessToken(event)
  const userId = await getUserIdFromAccessToken(event)
  const supabase = getSupabaseUserClient(accessToken)

  const body = (await readBody(event)) as Body
  if (!Array.isArray(body?.combos)) {
    throw createError({ statusCode: 400, statusMessage: 'combos debe ser un array' })
  }

  const { data, error } = await supabase
    .from('combo_workspaces')
    .upsert(
      {
        user_id: userId,
        combos: body.combos,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    )
    .select('updated_at')
    .single()

  if (error) {
    throw createError({ statusCode: 500, statusMessage: error.message })
  }

  return {
    ok: true,
    updated_at: data?.updated_at || null,
  }
})
