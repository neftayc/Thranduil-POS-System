import type { DashboardRepository, DashboardStatsResult } from '../ports'

export const getDashboardStats = async (repo: DashboardRepository): Promise<DashboardStatsResult> => {
  return repo.getStats()
}

