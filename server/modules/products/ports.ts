export type UnitCatalogItem = { code: string; label: string }
export type ProductCatalogItem = Record<string, any>

export type ProductsPageResult = {
  units: UnitCatalogItem[]
  products: ProductCatalogItem[]
}

export type UpsertProductCatalogInput = {
  p_id?: string | null
  p_sku?: string | null
  p_name: string
  p_unit?: string | null
  p_brand?: string | null
  p_product_type?: string | null
  p_barcode?: string | null
  p_active?: boolean
  p_sale_price?: number
  p_min_stock?: number
  p_stock_on_hand?: number | null
  p_avg_cost?: number | null
  p_currency?: string
}

export type ReplaceConversionsInput = {
  p_product_id: string
  p_items: any
}

export type ProductsRepository = {
  getPage(): Promise<ProductsPageResult>
  upsertCatalog(input: UpsertProductCatalogInput): Promise<{ id: string }>
  replaceConversions(input: ReplaceConversionsInput): Promise<{ ok: true }>
  getConversions(productId: string): Promise<{ items: Array<{ unit_name: string; factor_to_base: number; is_active: boolean }> }>
}

