import { createClient } from '@supabase/supabase-js'
import { createError } from 'h3'

type SupabaseConfig = {
  supabaseUrl: string
  supabaseAnonKey: string
  supabaseServiceRole: string
}

const isLocalSupabaseUrl = (url: string) => {
  try {
    const { hostname } = new URL(url)
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname.endsWith('.localhost')
  } catch {
    return false
  }
}

// Guard against touching a remote database by accident while developing.
// In development (`nuxt dev`, scripts), a remote Supabase URL requires APP_ENV=production|staging set on purpose,
// and APP_ENV=local only accepts a local URL. Deployed builds (NODE_ENV=production) are not affected.
const assertEnvironmentMatches = (supabaseUrl: string) => {
  const appEnv = String(process.env.APP_ENV || '').trim().toLowerCase()
  const local = isLocalSupabaseUrl(supabaseUrl)
  const developing = process.env.NODE_ENV !== 'production'

  if (appEnv === 'local' && !local) {
    throw createError({ statusCode: 500, statusMessage: 'APP_ENV=local pero SUPABASE_URL apunta a una base remota' })
  }
  if (developing && !local && appEnv !== 'production' && appEnv !== 'staging') {
    throw createError({
      statusCode: 500,
      statusMessage: 'SUPABASE_URL remota en desarrollo: define APP_ENV=production o APP_ENV=staging a propósito'
    })
  }
}

const getSupabaseConfig = (): SupabaseConfig => {
  // Use env vars directly to avoid depending on Nuxt's virtual `#imports` module during build-time evaluation.
  // Nuxt runtimeConfig is still sourced from the same env vars in `nuxt.config.ts`.
  const supabaseUrl = String(process.env.SUPABASE_URL || process.env.NUXT_PUBLIC_SUPABASE_URL || '').trim()
  const supabaseAnonKey = String(process.env.SUPABASE_ANON_KEY || process.env.NUXT_PUBLIC_SUPABASE_ANON_KEY || '').trim()
  const supabaseServiceRole = String(process.env.SUPABASE_SERVICE_ROLE || '').trim()

  if (!supabaseUrl) {
    throw createError({ statusCode: 500, statusMessage: 'Falta SUPABASE_URL' })
  }
  if (!supabaseAnonKey) {
    throw createError({ statusCode: 500, statusMessage: 'Falta SUPABASE_ANON_KEY' })
  }

  assertEnvironmentMatches(supabaseUrl)

  return { supabaseUrl, supabaseAnonKey, supabaseServiceRole }
}

export const getSupabaseAnonClient = () => {
  const { supabaseUrl, supabaseAnonKey } = getSupabaseConfig()
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  })
}

export const getSupabaseUserClient = (accessToken: string) => {
  const { supabaseUrl, supabaseAnonKey } = getSupabaseConfig()
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    },
    accessToken: async () => accessToken
  })
}

export const getSupabaseAdminClient = () => {
  const { supabaseUrl, supabaseServiceRole } = getSupabaseConfig()

  if (!supabaseServiceRole) {
    throw createError({ statusCode: 500, statusMessage: 'Falta SUPABASE_SERVICE_ROLE' })
  }

  return createClient(supabaseUrl, supabaseServiceRole, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  })
}
