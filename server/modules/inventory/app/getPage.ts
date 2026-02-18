import type { InventoryPageResult, InventoryRepository } from '../ports'

export const getInventoryPage = async (repo: InventoryRepository): Promise<InventoryPageResult> => {
  return repo.getPage()
}

