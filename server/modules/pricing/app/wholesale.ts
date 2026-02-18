import type { PricingRepository, WholesaleTierInput } from '../ports'

export const createWholesaleTier = async (repo: PricingRepository, input: WholesaleTierInput) => repo.createWholesale(input)
export const updateWholesaleTier = async (repo: PricingRepository, id: string, input: Omit<WholesaleTierInput, 'product_id'>) =>
  repo.updateWholesale(id, input)
export const deleteWholesaleTier = async (repo: PricingRepository, id: string) => repo.deleteWholesale(id)

