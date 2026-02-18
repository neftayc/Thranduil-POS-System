import type { SalesRepository } from '../ports'

export const payHeldSalesOrder = async (repo: SalesRepository, orderId: string, payment_method: string | null) =>
  repo.payHeld(orderId, payment_method)

