import type { ResolvePricingInput, SalesRepository } from '../ports'

export const resolveSaleItemPricing = async (repo: SalesRepository, input: ResolvePricingInput) => repo.resolvePricing(input)

