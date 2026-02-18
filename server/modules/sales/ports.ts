export type SalesPageResult = {
  products: any[]
  conversions: any[]
  paymentMethods: any[]
  customers: any[]
  customerGroups: any[]
  salesHistory: any[]
}

export type ResolvePricingInput = {
  product_id: string
  unit_name: string
  qty_uom: number
  customer_id: string | null
  sale_at: string
}

export type HoldOrderItem = {
  product_id: string
  qty: number
  unit_name: string
  price_unit: number
}

export type HoldOrderInput = {
  customer_id: string | null
  payment_method: string | null
  notes: string | null
  items: HoldOrderItem[]
}

export type CreateSaleItem = {
  product_id: string
  qty: number
  unit_name: string
  price_unit: number
  // Optional manual overrides supported by the DB RPC (if present).
  manual_discount_pct?: number
  manual_discount_amount?: number
  manual_discount_reason?: string | null
}

export type CreateSaleInput = {
  customer_id: string | null
  payment_method: string | null
  items: CreateSaleItem[]
}

export type SalesRepository = {
  getPage(): Promise<SalesPageResult>
  resolvePricing(input: ResolvePricingInput): Promise<{ pricing: any }>
  holdOrder(input: HoldOrderInput): Promise<{ ok: true; orderId: any }>
  listHeld(): Promise<{ orders: any[] }>
  deleteHeld(orderId: string): Promise<{ ok: true }>
  payHeld(orderId: string, payment_method: string | null): Promise<{ ok: true; saleId: any }>
  createSale(input: CreateSaleInput): Promise<{ ok: true; saleId: any }>
}

