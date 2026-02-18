import type { AdminRepository, CreateUserInput } from '../ports'

export const createUser = async (repo: AdminRepository, input: CreateUserInput) => repo.createUser(input)

