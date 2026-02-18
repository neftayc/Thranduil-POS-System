import type { SalesRepository } from '../ports'

export const listHeldSalesOrders = async (repo: SalesRepository) => repo.listHeld()

