import type { HoldOrderInput, SalesRepository } from '../ports'

export const holdSalesOrder = async (repo: SalesRepository, input: HoldOrderInput) => repo.holdOrder(input)

