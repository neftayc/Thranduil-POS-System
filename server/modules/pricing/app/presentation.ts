import type { PresentationRuleInput, PresentationRuleUpdateInput, PricingRepository } from '../ports'

export const createPresentationRule = async (repo: PricingRepository, input: PresentationRuleInput) => repo.createPresentation(input)
export const updatePresentationRule = async (repo: PricingRepository, id: string, input: PresentationRuleUpdateInput) =>
  repo.updatePresentation(id, input)
export const deletePresentationRule = async (repo: PricingRepository, id: string) => repo.deletePresentation(id)
