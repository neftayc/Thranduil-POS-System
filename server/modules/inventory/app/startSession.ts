import type { InventoryRepository, StartInventorySessionResult } from '../ports'

export const startInventorySession = async (
  repo: InventoryRepository,
  input: { userId: string; notes: string | null }
): Promise<StartInventorySessionResult> => {
  return repo.startSession(input)
}

