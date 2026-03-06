export type MaintenanceDataResult = {
  units: any[]
  paymentMethods: any[]
  customerGroups: any[]
  categories: any[]
}

export type MaintenanceRepository = {
  getAll(): Promise<MaintenanceDataResult>
  createUnit(input: { code: string; label: string }): Promise<{ ok: true }>
  updateUnit(code: string, input: { label: string; active: boolean }): Promise<{ ok: true }>
  createPaymentMethod(input: { code: string; label: string; sort_order: number }): Promise<{ ok: true }>
  updatePaymentMethod(code: string, input: { label: string; active: boolean; sort_order: number }): Promise<{ ok: true }>
  createCustomerGroup(input: { code: string; label: string; sort_order: number }): Promise<{ ok: true }>
  updateCustomerGroup(code: string, input: { label: string; active: boolean; sort_order: number }): Promise<{ ok: true }>
  createCategory(input: { code: string; label: string; sort_order: number }): Promise<{ ok: true }>
  updateCategory(code: string, input: { label: string; active: boolean; sort_order: number }): Promise<{ ok: true }>
}
