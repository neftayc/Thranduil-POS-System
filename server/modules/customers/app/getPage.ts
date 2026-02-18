import type { CustomersPageResult, CustomersRepository } from '../ports'

export const getCustomersPage = async (repo: CustomersRepository): Promise<CustomersPageResult> => {
  return repo.getPage()
}

