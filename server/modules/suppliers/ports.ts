export type Supplier = Record<string, any>

export type SuppliersRepository = {
  list(): Promise<{ suppliers: Supplier[] }>
  save(input: { id?: string; name: string; phone: string | null; email: string | null; address: string | null; notes: string | null }): Promise<{ ok: true }>
}

