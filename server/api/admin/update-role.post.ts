import { requireOwner } from '../../utils/auth'
import { updateUserRole } from '../../modules/admin/app/updateRole'
import { makeSupabaseAdminRepository } from '../../modules/admin/infra/supabaseAdminRepository'

type Body = {
  user_id: string
  role: 'owner' | 'manager' | 'cashier'
}

export default defineEventHandler(async (event) => {
  const { userId: currentUserId } = await requireOwner(event)
  const body = (await readBody(event)) as Body
  const repo = makeSupabaseAdminRepository()
  return await updateUserRole(repo, { currentUserId, user_id: body.user_id, role: body.role })
})
