import { createError } from 'h3'

import type { SuppliersRepository } from '../ports'
import { getSupabaseUserClient } from '../../../utils/supabase'

export const makeSupabaseSuppliersRepository = (accessToken: string): SuppliersRepository => {
  const supabase = getSupabaseUserClient(accessToken)

  return {
    async list() {
      const { data, error } = await supabase.from('suppliers').select('*').order('name')
      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      return { suppliers: data || [] }
    },

    async save(input) {
      const id = String(input?.id || '').trim()
      const name = String(input?.name || '').trim()
      if (!name) {
        throw createError({ statusCode: 400, statusMessage: 'Nombre obligatorio' })
      }

      const payload = {
        name,
        phone: input?.phone ? String(input.phone).trim() : null,
        email: input?.email ? String(input.email).trim() : null,
        address: input?.address ? String(input.address).trim() : null,
        notes: input?.notes ? String(input.notes).trim() : null
      }

      const query = id ? supabase.from('suppliers').update(payload).eq('id', id) : supabase.from('suppliers').insert(payload)
      const { error } = await query
      if (error) throw createError({ statusCode: 500, statusMessage: error.message })

      return { ok: true as const }
    }
  }
}

