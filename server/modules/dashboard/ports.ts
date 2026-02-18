export type DashboardStatsResult = {
  products: any[]
  purchases: any[]
  sales: any[]
  saleMovements: any[]
}

export type DashboardRepository = {
  getStats(): Promise<DashboardStatsResult>
}

