import type { CustomerGroupPriceInput, PricingRepository } from '../ports'

export const createCustomerGroupPrice = async (repo: PricingRepository, input: CustomerGroupPriceInput) => repo.createCustomerGroupPrice(input)
export const updateCustomerGroupPrice = async (
  repo: PricingRepository,
  id: string,
  input: Omit<CustomerGroupPriceInput, 'product_id'>
) => repo.updateCustomerGroupPrice(id, input)
export const deleteCustomerGroupPrice = async (repo: PricingRepository, id: string) => repo.deleteCustomerGroupPrice(id)

