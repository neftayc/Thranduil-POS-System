import type { CloseInventorySessionInput, CloseInventorySessionResult, InventoryRepository } from '../ports'

export const closeInventorySession = async (
  repo: InventoryRepository,
  input: CloseInventorySessionInput & { userId: string }
): Promise<CloseInventorySessionResult> => {
  return repo.closeSession(input)
}

