import { createClient } from '@supabase/supabase-js'
import { createError } from 'h3'

type SupabaseConfig = {
  supabaseUrl: string
  supabaseAnonKey: string
  supabaseServiceRole: string
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
