import type { ProductsRepository, ReplaceConversionsInput } from '../ports'

export const replaceProductUnitConversions = async (repo: ProductsRepository, input: ReplaceConversionsInput) =>
  repo.replaceConversions(input)

