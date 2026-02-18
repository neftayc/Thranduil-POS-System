import type { CreatePurchaseInput, PurchasesRepository } from '../ports'

export const createPurchase = async (repo: PurchasesRepository, input: CreatePurchaseInput) => repo.createPurchase(input)

