import type { PricingRepository, PricingRulesResult } from '../ports'

export const getPricingRules = async (repo: PricingRepository, productId: string): Promise<PricingRulesResult> =>
  repo.getRules(productId)

