import type { PricingCatalogsResult, PricingRepository } from '../ports'

export const getPricingCatalogs = async (repo: PricingRepository): Promise<PricingCatalogsResult> => repo.getCatalogs()

