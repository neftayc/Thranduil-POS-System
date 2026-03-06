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

export type UpdatePurchaseItemInput = {
  id: string
  qty: number
  unit_name: string
  cost_unit: number
}

export type UpdatePurchaseItemsInput = {
  purchase_id: string
  items: UpdatePurchaseItemInput[]
}

export type PurchasesRepository = {
  getPage(): Promise<PurchasesPageResult>
  createPurchase(input: CreatePurchaseInput): Promise<{ ok: true }>
  updatePurchaseItems(input: UpdatePurchaseItemsInput): Promise<{ ok: true }>
}
