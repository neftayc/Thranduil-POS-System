import type { FinancialSummaryResult, ProductProfitabilityQuery, ReportsRepository } from '../ports'

export const getFinancialSummary = async (
  repo: ReportsRepository,
  query?: ProductProfitabilityQuery
): Promise<FinancialSummaryResult> => {
  return repo.getFinancialSummary(query)
}
