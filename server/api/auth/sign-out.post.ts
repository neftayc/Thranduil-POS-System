import { defineEventHandler, getCookie } from 'h3'

import { clearAuthCookies } from '../../utils/auth'
import { signOut } from '../../modules/auth/app/signOut'
import { makeSupabaseAuthRepository } from '../../modules/auth/infra/supabaseAuthRepository'

export default defineEventHandler(async (event) => {
  const repo = makeSupabaseAuthRepository()
  const accessToken = String(getCookie(event, 'papeleria_at') || '')

  await signOut(repo, accessToken)

  clearAuthCookies(event)
  return { ok: true }
})
