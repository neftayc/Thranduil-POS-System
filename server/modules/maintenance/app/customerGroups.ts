import type { MaintenanceRepository } from '../ports'

export const createCustomerGroup = async (repo: MaintenanceRepository, input: { code: string; label: string; sort_order: number }) =>
  repo.createCustomerGroup(input)
export const updateCustomerGroup = async (
  repo: MaintenanceRepository,
  code: string,
  input: { label: string; active: boolean; sort_order: number }
) => repo.updateCustomerGroup(code, input)

