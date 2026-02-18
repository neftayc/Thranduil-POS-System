import type { AdminRepository } from '../ports'

export const listUsers = async (repo: AdminRepository) => repo.listUsers()

