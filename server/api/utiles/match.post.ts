import { requireAccessToken } from '../../utils/auth'
import { getSupabaseUserClient } from '../../utils/supabase'
import { matchProductsCore } from '../../utils/aiLogic'

export default defineEventHandler(async (event) => {
  let token = ''
  
  const authHeader = getRequestHeader(event, 'authorization') || ''
  const internalToken = getRequestHeader(event, 'x-webhook-token') || ''
  
  if (internalToken) {
    token = internalToken
  } else if (authHeader.startsWith('Bearer ')) {
    token = authHeader.replace('Bearer ', '')
  } else {
    token = await requireAccessToken(event)
  }
  
  const supabase = getSupabaseUserClient(token)
  
  const body = await readBody(event) as {
    items: Array<{ qty: number; item: string; raw?: string }>
  }

  if (!body?.items || !Array.isArray(body.items) || body.items.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'Se requiere un array de items' })
  }

  try {
     return await matchProductsCore(body.items, supabase)
  } catch (err: any) {
     throw createError({ statusCode: 500, statusMessage: err.message })
  }
})
