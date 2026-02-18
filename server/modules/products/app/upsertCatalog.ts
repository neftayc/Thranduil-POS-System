import type { ProductsRepository, UpsertProductCatalogInput } from '../ports'

export const upsertProductCatalog = async (repo: ProductsRepository, input: UpsertProductCatalogInput) => repo.upsertCatalog(input)

