import type {
  ExecutiveProfitabilityResult,
  ProductProfitabilityQuery,
  ReportsRepository
} from '../ports'

export const getExecutiveProfitability = async (
  repo: ReportsRepository,
  query?: ProductProfitabilityQuery
): Promise<ExecutiveProfitabilityResult> => {
  return repo.getExecutiveProfitability(query)
}
