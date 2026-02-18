import type { MaintenanceRepository } from '../ports'

export const createUnit = async (repo: MaintenanceRepository, input: { code: string; label: string }) => repo.createUnit(input)
export const updateUnit = async (repo: MaintenanceRepository, code: string, input: { label: string; active: boolean }) =>
  repo.updateUnit(code, input)

