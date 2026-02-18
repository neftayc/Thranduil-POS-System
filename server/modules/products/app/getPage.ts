import type { ProductsPageResult, ProductsRepository } from '../ports'

export const getProductsPage = async (repo: ProductsRepository): Promise<ProductsPageResult> => repo.getPage()

