import { createError } from 'h3'

import type { AuthRepository, SignUpResult } from '../ports'

export const signUp = async (
  repo: AuthRepository,
  input: { email: string; password: string; full_name?: string }
): Promise<SignUpResult> => {
  const email = String(input?.email || '').trim()
  const password = String(input?.password || '')
  const fullName = String(input?.full_name || '').trim()

  if (!email || !password) {
    throw createError({ statusCode: 400, statusMessage: 'Datos incompletos' })
  }

  const { session } = await repo.signUp({ email, password, fullName })

  return {
    session,
    needsEmailConfirmation: !session,
    message: 'Cuenta creada. Revisa tu correo si Supabase requiere confirmación.'
  }
}

