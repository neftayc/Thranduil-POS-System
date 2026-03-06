import type { MaintenanceRepository } from '../ports'

export const createCategory = async (repo: MaintenanceRepository, input: { code: string; label: string; sort_order: number }) =>
  repo.createCategory(input)
export const updateCategory = async (
  repo: MaintenanceRepository,
  code: string,
  input: { label: string; active: boolean; sort_order: number }
) => repo.updateCategory(code, input)
