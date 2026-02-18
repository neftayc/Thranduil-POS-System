import type { SalesRepository } from '../ports'

export const deleteHeldSalesOrder = async (repo: SalesRepository, orderId: string) => repo.deleteHeld(orderId)

