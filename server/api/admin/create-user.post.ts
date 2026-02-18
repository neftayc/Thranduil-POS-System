import { requireOwner } from '../../utils/auth'
import { createUser } from '../../modules/admin/app/createUser'
import { makeSupabaseAdminRepository } from '../../modules/admin/infra/supabaseAdminRepository'

type Body = {
  email: string
  password: string
  full_name?: string
  role?: 'owner' | 'manager' | 'cashier'
}

export default defineEventHandler(async (event) => {
  await requireOwner(event)
  const repo = makeSupabaseAdminRepository()
  const body = (await readBody(event)) as Body
  return await createUser(repo, body)
})
