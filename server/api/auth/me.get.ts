import { defineEventHandler, createError } from 'h3'

import { clearAuthCookies, getUserRole, requireAccessToken } from '../../utils/auth'
import { getMe } from '../../modules/auth/app/getMe'
import { makeSupabaseAuthRepository } from '../../modules/auth/infra/supabaseAuthRepository'

export default defineEventHandler(async (event) => {
  const repo = makeSupabaseAuthRepository()
  const accessToken = await requireAccessToken(event)
  const user = await getMe(repo, accessToken)
  if (!user) {
    clearAuthCookies(event)
    throw createError({ statusCode: 401, statusMessage: 'No autenticado' })
  }

  const role = await getUserRole(event)

  return {
    user,
    role
  }
})
