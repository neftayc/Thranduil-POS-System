import type { ProductsRepository } from '../ports'

export const getProductUnitConversions = async (repo: ProductsRepository, productId: string) => repo.getConversions(productId)

