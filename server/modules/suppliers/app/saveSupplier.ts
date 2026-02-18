import type { SuppliersRepository } from '../ports'

export const saveSupplier = async (
  repo: SuppliersRepository,
  input: { id?: string; name: string; phone: string | null; email: string | null; address: string | null; notes: string | null }
) => repo.save(input)

