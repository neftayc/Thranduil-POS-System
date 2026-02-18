import type { SuppliersRepository } from '../ports'

export const listSuppliers = async (repo: SuppliersRepository) => repo.list()

