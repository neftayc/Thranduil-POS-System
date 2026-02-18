import { defineEventHandler, readBody, createError } from 'h3'

import { setAuthCookies } from '../../utils/auth'
import { signIn } from '../../modules/auth/app/signIn'
import { makeSupabaseAuthRepository } from '../../modules/auth/infra/supabaseAuthRepository'

type Body = {
  email?: string
  password?: string
}

export default defineEventHandler(async (event) => {
  const repo = makeSupabaseAuthRepository()
  const body = (await readBody(event)) as Body
  try {
    const result = await signIn(repo, {
      email: String(body?.email || '').trim(),
      password: String(body?.password || '')
    })

    setAuthCookies(event, result.session)

    return {
      ok: true,
      user: result.user,
      role: result.role
    }
  } catch (err: any) {
    if (err?.statusCode) throw err
    throw createError({ statusCode: 500, statusMessage: err?.message || 'Error inesperado' })
  }
})
