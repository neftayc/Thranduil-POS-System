import { createError } from 'h3'

import type { AuthRepository, SignInResult } from '../ports'

export const signIn = async (
  repo: AuthRepository,
  input: { email: string; password: string }
): Promise<SignInResult> => {
  const email = String(input?.email || '').trim()
  const password = String(input?.password || '')

  if (!email || !password) {
    throw createError({ statusCode: 400, statusMessage: 'Datos incompletos' })
  }

  const { session, user } = await repo.signIn(email, password)

  let role = 'cashier'
  try {
    const resolved = await repo.resolveRole(session.access_token)
    if (resolved) role = resolved
  } catch {
    // Ignore role load errors during sign-in.
  }

  return { session, user, role }
}

