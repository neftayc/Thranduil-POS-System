import { createError } from 'h3'

import type { AuthRepository, AuthUser } from '../ports'
import { getSupabaseAnonClient, getSupabaseUserClient } from '../../../utils/supabase'

export const makeSupabaseAuthRepository = (): AuthRepository => {
  const supabase = getSupabaseAnonClient()

  return {
    async signIn(email: string, password: string) {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password })

      if (error) {
        throw createError({ statusCode: 401, statusMessage: error.message })
      }
      if (!data.session || !data.user) {
        throw createError({ statusCode: 401, statusMessage: 'No se pudo iniciar sesión' })
      }

      return {
        session: {
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
          expires_in: data.session.expires_in
        },
        user: {
          id: data.user.id,
          email: data.user.email || null
        }
      }
    },

    async signUp(input: { email: string; password: string; fullName: string }) {
      const { data, error } = await supabase.auth.signUp({
        email: input.email,
        password: input.password,
        options: {
          data: { full_name: input.fullName || null }
        }
      })

      if (error) {
        throw createError({ statusCode: 400, statusMessage: error.message })
      }

      const session = data.session
        ? {
            access_token: data.session.access_token,
            refresh_token: data.session.refresh_token,
            expires_in: data.session.expires_in
          }
        : null

      return { session }
    },

    async resolveRole(accessToken: string) {
      const supabaseUser = getSupabaseUserClient(accessToken)
      const { data } = await supabaseUser.rpc('user_role')
      return typeof data === 'string' ? data : ''
    },

    async getUser(accessToken: string): Promise<AuthUser | null> {
      const { data, error } = await supabase.auth.getUser(accessToken)
      if (error || !data.user) {
        return null
      }

      return {
        id: data.user.id,
        email: data.user.email || null
      }
    },

    async revokeSession(accessToken: string) {
      if (!accessToken) return
      // Best-effort token revocation.
      try {
        await supabase.auth.admin.signOut(accessToken, 'global')
      } catch {
        // ignore
      }
    }
  }
}

