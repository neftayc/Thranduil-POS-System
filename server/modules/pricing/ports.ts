export type PricingCatalogsResult = {
  products: any[]
  units: any[]
  customerGroups: any[]
}

export type PricingRulesResult = {
  presentationRules: any[]
  wholesaleTiers: any[]
  promotions: any[]
  customerGroupPrices: any[]
}

export type PresentationRuleInput = {
  product_id: string
  unit_name: string
  customer_group: string | null
  price_uom: number
  priority: number
  active: boolean
}

export type PresentationRuleUpdateInput = {
  unit_name?: string
  customer_group?: string | null
  price_uom?: number
  priority?: number
  active?: boolean
}

export type WholesaleTierInput = {
  product_id: string
  customer_group: string | null
  min_qty_base: number
  unit_price_base: number
  priority: number
  active: boolean
}

export type PromotionInput = {
  product_id: string
  name: string
  unit_name: string | null
  customer_group: string | null
  promo_type: string
  promo_value: number
  min_qty_base: number
  starts_at: string | null
  ends_at: string | null
  priority: number
  active: boolean
}

export type CustomerGroupPriceInput = {
  product_id: string
  customer_group: string | null
  unit_price_base: number
  priority: number
  active: boolean
}

export type PricingRepository = {
  getCatalogs(): Promise<PricingCatalogsResult>
  getRules(productId: string): Promise<PricingRulesResult>

  createPresentation(input: PresentationRuleInput): Promise<{ ok: true }>
  updatePresentation(id: string, input: PresentationRuleUpdateInput): Promise<{ ok: true }>
  deletePresentation(id: string): Promise<{ ok: true }>

  createWholesale(input: WholesaleTierInput): Promise<{ ok: true }>
  updateWholesale(id: string, input: Omit<WholesaleTierInput, 'product_id'>): Promise<{ ok: true }>
  deleteWholesale(id: string): Promise<{ ok: true }>

  createPromotion(input: PromotionInput): Promise<{ ok: true }>
  updatePromotion(id: string, input: Omit<PromotionInput, 'product_id'>): Promise<{ ok: true }>
  deletePromotion(id: string): Promise<{ ok: true }>

  createCustomerGroupPrice(input: CustomerGroupPriceInput): Promise<{ ok: true }>
  updateCustomerGroupPrice(id: string, input: Omit<CustomerGroupPriceInput, 'product_id'>): Promise<{ ok: true }>
  deleteCustomerGroupPrice(id: string): Promise<{ ok: true }>
}
