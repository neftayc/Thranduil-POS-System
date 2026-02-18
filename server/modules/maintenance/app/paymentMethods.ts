import type { MaintenanceRepository } from '../ports'

export const createPaymentMethod = async (repo: MaintenanceRepository, input: { code: string; label: string; sort_order: number }) =>
  repo.createPaymentMethod(input)
export const updatePaymentMethod = async (
  repo: MaintenanceRepository,
  code: string,
  input: { label: string; active: boolean; sort_order: number }
) => repo.updatePaymentMethod(code, input)

