export type InventoryCountSession = {
  id: string
  code: string
  status: string
  notes?: string | null
  opened_at?: string | null
}

export type InventoryCountItem = {
  id: string
  session_id: string
  product_id: string
  stock_system: number
  counted: number
  non_sellable: number
  stock_final: number
  delta_qty: number
  avg_cost: number
  reason: string | null
  reconfirmed: boolean | null
  applied: boolean | null
  applied_at: string | null
  updated_at: string | null
}

export type ProductCatalogRow = {
  id: string
  sku: string | null
  name: string
  brand: string | null
  unit: string | null
  stock_on_hand: number | null
  min_stock: number | null
  avg_cost: number | null
  sale_price: number | null
  active: boolean | null
}

export type InventoryPageResult = {
  products: ProductCatalogRow[]
  session: InventoryCountSession | null
  sessionItems: InventoryCountItem[]
}

export type StartInventorySessionResult = {
  session: InventoryCountSession
  alreadyOpen: boolean
}

export type ApplyInventoryAdjustmentInput = {
  session_id: string
  product_id: string
  stock_final: number
  non_sellable: number
  reason: string
  reconfirmed: boolean
  active: boolean | null
}

export type ApplyInventoryAdjustmentResult =
  | { ok: true; changed: false }
  | { ok: true; changed: true; item: InventoryCountItem }

export type CloseInventorySessionInput = {
  session_id: string
  notes: string | null
}

export type CloseInventorySessionResult = {
  ok: true
  closedAt: string
}

export type InventoryRepository = {
  getPage(): Promise<InventoryPageResult>
  startSession(input: { userId: string; notes: string | null }): Promise<StartInventorySessionResult>
  applyAdjustment(input: ApplyInventoryAdjustmentInput & { userId: string }): Promise<ApplyInventoryAdjustmentResult>
  closeSession(input: CloseInventorySessionInput & { userId: string }): Promise<CloseInventorySessionResult>
}
