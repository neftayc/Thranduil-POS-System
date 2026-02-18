import { createError } from 'h3'

import type { AdminRepository, CreateUserInput, Profile, UpdateRoleInput, UserRole, UserRow } from '../ports'
import { getSupabaseAdminClient } from '../../../utils/supabase'

const allowedRoles = new Set<UserRole>(['owner', 'manager', 'cashier'])

export const makeSupabaseAdminRepository = (): AdminRepository => {
  const supabase = getSupabaseAdminClient()

  return {
    async listUsers(): Promise<{ users: UserRow[] }> {
      const { data: usersData, error: usersError } = await supabase.auth.admin.listUsers({ page: 1, perPage: 200 })
      if (usersError) {
        throw createError({ statusCode: 500, statusMessage: usersError.message })
      }

      const ids = usersData.users.map((u) => u.id)
      const { data: profilesData, error: profileError } = ids.length
        ? await supabase.from('profiles').select('id, full_name, role').in('id', ids)
        : ({ data: [] as any[], error: null } as any)

      if (profileError) throw createError({ statusCode: 500, statusMessage: profileError.message })

      const profileMap = new Map<string, Profile>()
      ;(profilesData || []).forEach((p: any) => profileMap.set(p.id, p as Profile))

      const result: UserRow[] = usersData.users.map((u) => ({
        id: u.id,
        email: u.email,
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at,
        profile: profileMap.get(u.id) || null
      }))

      return { users: result }
    },

    async createUser(input: CreateUserInput): Promise<{ id: string }> {
      if (!input?.email || !input?.password) {
        throw createError({ statusCode: 400, statusMessage: 'Datos incompletos' })
      }

      const role: UserRole = input.role && allowedRoles.has(input.role) ? input.role : 'cashier'

      const { data: userData, error: createErrorUser } = await supabase.auth.admin.createUser({
        email: input.email,
        password: input.password,
        email_confirm: true,
        user_metadata: { full_name: input.full_name || null }
      })

      if (createErrorUser || !userData.user) {
        throw createError({ statusCode: 500, statusMessage: createErrorUser?.message || 'Error creando usuario' })
      }

      const { error: profileUpdateError } = await supabase
        .from('profiles')
        .update({ full_name: input.full_name || null, role })
        .eq('id', userData.user.id)

      if (profileUpdateError) {
        throw createError({ statusCode: 500, statusMessage: profileUpdateError.message })
      }

      return { id: userData.user.id }
    },

    async updateRole(input: UpdateRoleInput): Promise<{ ok: true }> {
      if (!input?.user_id || !input?.role || !allowedRoles.has(input.role)) {
        throw createError({ statusCode: 400, statusMessage: 'Datos inválidos' })
      }

      if (input.currentUserId === input.user_id && input.role !== 'owner') {
        throw createError({ statusCode: 400, statusMessage: 'No puedes quitar tu rol de owner' })
      }

      const { error: updateError } = await supabase.from('profiles').update({ role: input.role }).eq('id', input.user_id)
      if (updateError) {
        throw createError({ statusCode: 500, statusMessage: updateError.message })
      }

      return { ok: true as const }
    }
  }
}

