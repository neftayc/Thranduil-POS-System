import type { SalesPageResult, SalesRepository } from '../ports'

export const getSalesPage = async (repo: SalesRepository): Promise<SalesPageResult> => repo.getPage()

