import { getSupabaseAdminClient } from '../../../utils/supabase'
import type { AgentCatalog } from '../app/prepareSale'
import type { Product } from '../contracts'

const columns = 'id, name, sku, brand, unit, stock_on_hand'
const product = (row: any): Product => ({ id: row.id, name: row.name, sku: row.sku, brand: row.brand, unit: row.unit, stock: Number(row.stock_on_hand) })
const stopwords = new Set(['de', 'del', 'el', 'la', 'los', 'las', 'un', 'una', 'con', 'para', 'hoja', 'hojas'])
const tokens = (text: string) => text.match(/[\p{L}\p{N}]+/gu)?.filter(term => !stopwords.has(term.toLowerCase())).slice(0, 16) || []

export const makeSupabaseAgentCatalog = (): AgentCatalog => {
  const db = getSupabaseAdminClient()
  return {
    async findProducts(text, sku) {
      if (sku?.trim()) {
        const { data, error } = await db.from('product_catalog').select(columns).eq('active', true).eq('sku', sku.trim()).limit(8)
        if (error) throw error
        return (data || []).map(product)
      }
      const terms = tokens(text)
      if (!terms.length) return []
      let query = db.from('product_catalog').select(columns).eq('active', true)
      for (const term of terms) query = query.or(`name.ilike.%${term}%,brand.ilike.%${term}%,sku.ilike.%${term}%`)
      const { data, error } = await query.order('name').limit(8)
      if (error) throw error
      return (data || []).map(product)
    },
    async getProduct(id) {
      const { data, error } = await db.from('product_catalog').select(columns).eq('active', true).eq('id', id).maybeSingle()
      if (error) throw error
      return data ? product(data) : null
    },
    async findCustomers(text) {
      const terms = tokens(text)
      if (!terms.length) return []
      let query = db.from('customers').select('id, name')
      for (const term of terms) query = query.ilike('name', `%${term}%`)
      const { data, error } = await query.order('name').limit(8)
      if (error) throw error
      return data || []
    },
    async paymentMethods() {
      const { data, error } = await db.from('payment_method_catalog').select('code, label').eq('active', true).order('sort_order')
      if (error) throw error
      return data || []
    },
    async quote(item, qty, unit, customerId) {
      const { data, error } = await db.rpc('resolve_sale_item_pricing', {
        p_product_id: item.id, p_unit_name: unit || item.unit, p_qty_uom: qty,
        p_customer_id: customerId, p_sale_at: new Date().toISOString()
      })
      if (error || !data) throw error || new Error('Precio no disponible')
      return { unit_name: String(data.unit_name), price: Number(data.price_uom), factor: Number(data.factor), currency: String(data.currency).trim() }
    }
  }
}
