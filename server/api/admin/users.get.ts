import { requireOwner } from '../../utils/auth'

import { listUsers } from '../../modules/admin/app/listUsers'
import { makeSupabaseAdminRepository } from '../../modules/admin/infra/supabaseAdminRepository'

export default defineEventHandler(async (event) => {
  await requireOwner(event)
  const repo = makeSupabaseAdminRepository()
  return await listUsers(repo)
})
