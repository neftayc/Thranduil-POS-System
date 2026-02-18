import type { ApplyInventoryAdjustmentInput, ApplyInventoryAdjustmentResult, InventoryRepository } from '../ports'

export const applyInventoryAdjustment = async (
  repo: InventoryRepository,
  input: ApplyInventoryAdjustmentInput & { userId: string }
): Promise<ApplyInventoryAdjustmentResult> => {
  return repo.applyAdjustment(input)
}

