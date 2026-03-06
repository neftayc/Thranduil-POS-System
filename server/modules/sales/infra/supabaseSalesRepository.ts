import { createError } from 'h3'

import type {
  CreateSaleInput,
  HoldOrderInput,
  ResolvePricingInput,
  SalesPageResult,
  SalesRepository
} from '../ports'
import { getSupabaseUserClient } from '../../../utils/supabase'

export const makeSupabaseSalesRepository = (accessToken: string): SalesRepository => {
  const supabase = getSupabaseUserClient(accessToken)

  return {
    async getPage(): Promise<SalesPageResult> {
      const [productsRes, uomsRes, paymentRes, customersRes, customerGroupsRes, historyRes] = await Promise.all([
        supabase
          .from('product_catalog')
          .select('id, name, sku, brand, category_name, unit, sale_price, stock_on_hand')
          .eq('active', true)
          .order('name'),
        supabase
          .from('product_unit_conversions')
          .select('product_id, unit_name, factor_to_base, is_active')
          .eq('is_active', true),
        supabase
          .from('payment_method_catalog')
          .select('code, label')
          .eq('active', true)
          .order('sort_order')
          .order('label'),
        supabase.from('customers').select('id, name, customer_group').order('name'),
        supabase
          .from('customer_groups')
          .select('code, label')
          .eq('active', true)
          .order('sort_order')
          .order('label'),
        supabase
          .from('sales')
          .select(
            `
        id,
        sale_date,
        total,
        payment_method,
        created_at,
        customers (name),
        sale_items (
          id,
          unit_name,
          qty_uom,
          factor_to_base,
          price_unit_uom,
          qty,
          price_unit,
          total,
          products (name, sku, unit)
        )
      `
          )
          .order('created_at', { ascending: false })
          .limit(50)
      ])

      if (productsRes.error) throw createError({ statusCode: 500, statusMessage: productsRes.error.message })
      if (uomsRes.error) throw createError({ statusCode: 500, statusMessage: uomsRes.error.message })
      if (paymentRes.error) throw createError({ statusCode: 500, statusMessage: paymentRes.error.message })
      if (customersRes.error) throw createError({ statusCode: 500, statusMessage: customersRes.error.message })
      if (customerGroupsRes.error) throw createError({ statusCode: 500, statusMessage: customerGroupsRes.error.message })
      if (historyRes.error) throw createError({ statusCode: 500, statusMessage: historyRes.error.message })

      return {
        products: productsRes.data || [],
        conversions: uomsRes.data || [],
        paymentMethods: paymentRes.data || [],
        customers: customersRes.data || [],
        customerGroups: customerGroupsRes.data || [],
        salesHistory: historyRes.data || []
      }
    },

    async resolvePricing(input: ResolvePricingInput) {
      const productId = String(input?.product_id || '').trim()
      const unitName = String(input?.unit_name || '').trim()
      const qtyUom = Number(input?.qty_uom || 0)
      const saleAt = String(input?.sale_at || new Date().toISOString())

      if (!productId || !unitName || !Number.isFinite(qtyUom) || qtyUom <= 0) {
        throw createError({ statusCode: 400, statusMessage: 'Datos inválidos' })
      }

      const { data, error } = await supabase.rpc('resolve_sale_item_pricing', {
        p_product_id: productId,
        p_unit_name: unitName,
        p_qty_uom: qtyUom,
        p_customer_id: input?.customer_id || null,
        p_sale_at: saleAt
      })

      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      return { pricing: data || null }
    },

    async holdOrder(input: HoldOrderInput) {
      const items = Array.isArray(input?.items) ? input.items : []
      if (!items.length) {
        throw createError({ statusCode: 400, statusMessage: 'Items inválidos' })
      }

      const { data, error } = await supabase.rpc('create_sales_order', {
        p_customer_id: input?.customer_id || null,
        p_payment_method: input?.payment_method || null,
        p_items: items,
        p_notes: input?.notes || null
      })

      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      return { ok: true as const, orderId: data || null }
    },

    async listHeld() {
      const { data, error } = await supabase
        .from('sales_orders')
        .select(
          `
      id,
      order_code,
      status,
      customer_id,
      payment_method,
      notes,
      total,
      created_at,
      updated_at,
      sales_order_items (
        id,
        product_id,
        unit_name,
        qty_uom,
        factor_to_base,
        auto_price_unit,
        price_unit_uom,
        pricing_source,
        pricing_detail,
        total,
        products (name, sku)
      )
    `
        )
        .eq('status', 'open')
        .order('updated_at', { ascending: false })
        .limit(120)

      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      return { orders: data || [] }
    },

    async deleteHeld(orderId: string) {
      const id = String(orderId || '').trim()
      if (!id) {
        throw createError({ statusCode: 400, statusMessage: 'Pedido inválido' })
      }

      const { error } = await supabase.from('sales_orders').delete().eq('id', id).eq('status', 'open')
      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      return { ok: true as const }
    },

    async payHeld(orderId: string, payment_method: string | null) {
      const id = String(orderId || '').trim()
      if (!id) {
        throw createError({ statusCode: 400, statusMessage: 'Pedido inválido' })
      }

      const { data, error } = await supabase.rpc('pay_sales_order', {
        p_order_id: id,
        p_payment_method: payment_method || null
      })

      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      return { ok: true as const, saleId: data || null }
    },

    async createSale(input: CreateSaleInput) {
      const items = Array.isArray(input?.items) ? input.items : []
      if (!items.length) {
        throw createError({ statusCode: 400, statusMessage: 'Items inválidos' })
      }

      const { data, error } = await supabase.rpc('create_sale', {
        p_customer_id: input?.customer_id || null,
        p_payment_method: input?.payment_method || null,
        p_items: items
      })

      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      return { ok: true as const, saleId: data || null }
    }
  }
}
