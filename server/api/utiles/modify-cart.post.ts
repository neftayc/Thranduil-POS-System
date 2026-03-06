import { requireAccessToken } from '../../utils/auth'
import { getSupabaseUserClient } from '../../utils/supabase'
import { modifyCartCore, type MatchedLine } from '../../utils/aiLogic'

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
    cart: MatchedLine[]
    message: string
  }

  if (!body?.cart || !body?.message) {
    throw createError({ statusCode: 400, statusMessage: 'cart and message are required' })
  }

  try {
     return await modifyCartCore(body.cart, body.message, supabase)
  } catch (err: any) {
     throw createError({ statusCode: 500, statusMessage: err.message })
  }
})
