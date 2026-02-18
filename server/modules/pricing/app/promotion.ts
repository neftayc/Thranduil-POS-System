import type { PricingRepository, PromotionInput } from '../ports'

export const createPromotion = async (repo: PricingRepository, input: PromotionInput) => repo.createPromotion(input)
export const updatePromotion = async (repo: PricingRepository, id: string, input: Omit<PromotionInput, 'product_id'>) =>
  repo.updatePromotion(id, input)
export const deletePromotion = async (repo: PricingRepository, id: string) => repo.deletePromotion(id)

