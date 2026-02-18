import { createError } from 'h3'

import type { CustomersPageResult, CustomersRepository, SaveCustomerInput } from '../ports'
import { getSupabaseUserClient } from '../../../utils/supabase'

export const makeSupabaseCustomersRepository = (accessToken: string): CustomersRepository => {
  const supabase = getSupabaseUserClient(accessToken)

  return {
    async getPage(): Promise<CustomersPageResult> {
      const [customersRes, groupsRes] = await Promise.all([
        supabase.from('customers').select('*').order('name'),
        supabase
          .from('customer_groups')
          .select('code, label')
          .eq('active', true)
          .order('sort_order')
          .order('label')
      ])

      if (customersRes.error) throw createError({ statusCode: 500, statusMessage: customersRes.error.message })
      if (groupsRes.error) throw createError({ statusCode: 500, statusMessage: groupsRes.error.message })

      return {
        customers: customersRes.data || [],
        customerGroups: groupsRes.data || []
      }
    },

    async save(input: SaveCustomerInput) {
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
        notes: input?.notes ? String(input.notes).trim() : null,
        customer_group: input?.customer_group ? String(input.customer_group).trim() : 'minorista'
      }

      const query = id ? supabase.from('customers').update(payload).eq('id', id) : supabase.from('customers').insert(payload)
      const { error } = await query
      if (error) throw createError({ statusCode: 500, statusMessage: error.message })

      return { ok: true as const }
    }
  }
}

