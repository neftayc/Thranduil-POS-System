export type PurchasesPageResult = {
  uomCatalog: any[]
  suppliers: any[]
  products: any[]
  conversions: any[]
  history: any[]
}

export type PurchaseItemInput = {
  product_id: string
  qty: number
  unit_name: string
  cost_unit: number
}

export type CreatePurchaseInput = {
  supplier_id: string | null
  invoice_no: string | null
  items: PurchaseItemInput[]
}

export type PurchasesRepository = {
  getPage(): Promise<PurchasesPageResult>
  createPurchase(input: CreatePurchaseInput): Promise<{ ok: true }>
}

