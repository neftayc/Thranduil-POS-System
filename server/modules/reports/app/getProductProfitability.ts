import type { ProductProfitabilityQuery, ProductProfitabilityResult, ReportsRepository } from '../ports'

export const getProductProfitability = async (
  repo: ReportsRepository,
  query?: ProductProfitabilityQuery
): Promise<ProductProfitabilityResult> => {
  return repo.getProductProfitability(query)
}
