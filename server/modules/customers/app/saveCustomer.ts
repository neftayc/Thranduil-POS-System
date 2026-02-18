import type { CustomersRepository, SaveCustomerInput } from '../ports'

export const saveCustomer = async (repo: CustomersRepository, input: SaveCustomerInput) => {
  return repo.save(input)
}

