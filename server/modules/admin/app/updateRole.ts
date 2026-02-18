import type { AdminRepository, UpdateRoleInput } from '../ports'

export const updateUserRole = async (repo: AdminRepository, input: UpdateRoleInput) => repo.updateRole(input)

