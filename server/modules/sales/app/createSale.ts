import type { CreateSaleInput, SalesRepository } from '../ports'

export const createSale = async (repo: SalesRepository, input: CreateSaleInput) => repo.createSale(input)

