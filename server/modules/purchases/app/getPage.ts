import type { PurchasesPageResult, PurchasesRepository } from '../ports'

export const getPurchasesPage = async (repo: PurchasesRepository): Promise<PurchasesPageResult> => repo.getPage()

