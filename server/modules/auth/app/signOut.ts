import type { AuthRepository } from '../ports'

export const signOut = async (repo: AuthRepository, accessToken: string) => {
  await repo.revokeSession(accessToken)
}

