import { defineEventHandler, readBody, createError } from 'h3'

import { setAuthCookies } from '../../utils/auth'
import { signUp } from '../../modules/auth/app/signUp'
import { makeSupabaseAuthRepository } from '../../modules/auth/infra/supabaseAuthRepository'

type Body = {
  email?: string
  password?: string
  full_name?: string
}

export default defineEventHandler(async (event) => {
  const repo = makeSupabaseAuthRepository()
  const body = (await readBody(event)) as Body
  try {
    const result = await signUp(repo, body)
    if (result.session) {
      setAuthCookies(event, result.session)
    }

    return {
      ok: true,
      needsEmailConfirmation: result.needsEmailConfirmation,
      message: result.message
    }
  } catch (err: any) {
    if (err?.statusCode) throw err
    throw createError({ statusCode: 500, statusMessage: err?.message || 'Error inesperado' })
  }
})
