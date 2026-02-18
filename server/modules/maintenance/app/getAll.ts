import type { MaintenanceDataResult, MaintenanceRepository } from '../ports'

export const getMaintenanceData = async (repo: MaintenanceRepository): Promise<MaintenanceDataResult> => repo.getAll()

