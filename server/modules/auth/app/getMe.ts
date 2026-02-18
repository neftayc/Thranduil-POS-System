import type { AuthRepository } from '../ports'

export const getMe = async (repo: AuthRepository, accessToken: string) => {
  return repo.getUser(accessToken)
}

