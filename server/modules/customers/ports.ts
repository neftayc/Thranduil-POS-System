export type Customer = Record<string, any>
export type CustomerGroup = { code: string; label: string }

export type CustomersPageResult = {
  customers: Customer[]
  customerGroups: CustomerGroup[]
}

export type SaveCustomerInput = {
  id?: string
  name: string
  phone: string | null
  email: string | null
  address: string | null
  notes: string | null
  customer_group: string | null
}

export type CustomersRepository = {
  getPage(): Promise<CustomersPageResult>
  save(input: SaveCustomerInput): Promise<{ ok: true }>
}

