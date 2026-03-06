import type { PurchasesRepository, UpdatePurchaseItemsInput } from '../ports'

export const updatePurchaseItems = async (repo: PurchasesRepository, input: UpdatePurchaseItemsInput) =>
  repo.updatePurchaseItems(input)
