import { createError } from 'h3'

import type {
  CustomerGroupPriceInput,
  PresentationRuleInput,
  PresentationRuleUpdateInput,
  PricingCatalogsResult,
  PricingRepository,
  PricingRulesResult,
  PromotionInput,
  WholesaleTierInput
} from '../ports'
import { getSupabaseUserClient } from '../../../utils/supabase'

const requireId = (id: string, message: string) => {
  const value = String(id || '').trim()
  if (!value) throw createError({ statusCode: 400, statusMessage: message })
  return value
}

export const makeSupabasePricingRepository = (accessToken: string): PricingRepository => {
  const supabase = getSupabaseUserClient(accessToken)

  return {
    async getCatalogs(): Promise<PricingCatalogsResult> {
      const [productsRes, unitsRes, groupsRes] = await Promise.all([
        supabase.from('product_catalog').select('id, sku, name, unit, sale_price').order('name'),
        supabase.from('uom_catalog').select('code, label').eq('active', true).order('label'),
        supabase
          .from('customer_groups')
          .select('code, label')
          .eq('active', true)
          .order('sort_order')
          .order('label')
      ])

      if (productsRes.error) throw createError({ statusCode: 500, statusMessage: productsRes.error.message })
      if (unitsRes.error) throw createError({ statusCode: 500, statusMessage: unitsRes.error.message })
      if (groupsRes.error) throw createError({ statusCode: 500, statusMessage: groupsRes.error.message })

      return { products: productsRes.data || [], units: unitsRes.data || [], customerGroups: groupsRes.data || [] }
    },

    async getRules(productId: string): Promise<PricingRulesResult> {
      const id = requireId(productId, 'Producto inválido')

      const [presentationRes, wholesaleRes, promotionsRes, customerGroupRes] = await Promise.all([
        supabase
          .from('product_presentation_prices')
          .select('*')
          .eq('product_id', id)
          .order('priority')
          .order('created_at', { ascending: false }),
        supabase
          .from('product_wholesale_tiers')
          .select('*')
          .eq('product_id', id)
          .order('min_qty_base', { ascending: false })
          .order('priority'),
        supabase
          .from('product_promotions')
          .select('*')
          .eq('product_id', id)
          .order('priority')
          .order('starts_at', { ascending: false }),
        supabase
          .from('product_customer_group_prices')
          .select('*')
          .eq('product_id', id)
          .order('priority')
          .order('created_at', { ascending: false })
      ])

      if (presentationRes.error) throw createError({ statusCode: 500, statusMessage: presentationRes.error.message })
      if (wholesaleRes.error) throw createError({ statusCode: 500, statusMessage: wholesaleRes.error.message })
      if (promotionsRes.error) throw createError({ statusCode: 500, statusMessage: promotionsRes.error.message })
      if (customerGroupRes.error) throw createError({ statusCode: 500, statusMessage: customerGroupRes.error.message })

      return {
        presentationRules: presentationRes.data || [],
        wholesaleTiers: wholesaleRes.data || [],
        promotions: promotionsRes.data || [],
        customerGroupPrices: customerGroupRes.data || []
      }
    },

    async createPresentation(input: PresentationRuleInput) {
      const productId = requireId(input?.product_id, 'Datos inválidos')
      const unitName = requireId(input?.unit_name, 'Datos inválidos')

      const { error } = await supabase.from('product_presentation_prices').insert({
        product_id: productId,
        unit_name: unitName,
        customer_group: input?.customer_group || null,
        price_uom: Number((input as any)?.price_uom || 0),
        priority: Number((input as any)?.priority || 100),
        active: (input as any)?.active !== false
      })

      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      return { ok: true as const }
    },

    async updatePresentation(id: string, input: PresentationRuleUpdateInput) {
      const ruleId = requireId(id, 'ID inválido')

      const { error } = await supabase
        .from('product_presentation_prices')
        .update({
          unit_name: typeof (input as any)?.unit_name === 'undefined' ? undefined : (input as any)?.unit_name,
          customer_group: typeof (input as any)?.customer_group === 'undefined' ? undefined : (input as any)?.customer_group || null,
          price_uom: typeof (input as any)?.price_uom === 'undefined' ? undefined : Number((input as any)?.price_uom || 0),
          priority: typeof (input as any)?.priority === 'undefined' ? undefined : Number((input as any)?.priority || 100),
          active: typeof (input as any)?.active === 'undefined' ? undefined : (input as any)?.active !== false
        })
        .eq('id', ruleId)

      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      return { ok: true as const }
    },

    async deletePresentation(id: string) {
      const ruleId = requireId(id, 'ID inválido')
      const { error } = await supabase.from('product_presentation_prices').delete().eq('id', ruleId)
      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      return { ok: true as const }
    },

    async createWholesale(input: WholesaleTierInput) {
      const productId = requireId(input?.product_id, 'Producto inválido')
      const { error } = await supabase.from('product_wholesale_tiers').insert({
        product_id: productId,
        customer_group: input?.customer_group || null,
        min_qty_base: Number((input as any)?.min_qty_base || 1),
        unit_price_base: Number((input as any)?.unit_price_base || 0),
        priority: Number((input as any)?.priority || 100),
        active: (input as any)?.active !== false
      })
      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      return { ok: true as const }
    },

    async updateWholesale(id: string, input: Omit<WholesaleTierInput, 'product_id'>) {
      const tierId = requireId(id, 'ID inválido')
      const { error } = await supabase
        .from('product_wholesale_tiers')
        .update({
          customer_group: (input as any)?.customer_group || null,
          min_qty_base: Number((input as any)?.min_qty_base || 1),
          unit_price_base: Number((input as any)?.unit_price_base || 0),
          priority: Number((input as any)?.priority || 100),
          active: (input as any)?.active !== false
        })
        .eq('id', tierId)
      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      return { ok: true as const }
    },

    async deleteWholesale(id: string) {
      const tierId = requireId(id, 'ID inválido')
      const { error } = await supabase.from('product_wholesale_tiers').delete().eq('id', tierId)
      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      return { ok: true as const }
    },

    async createPromotion(input: PromotionInput) {
      const productId = requireId(input?.product_id, 'Datos inválidos')
      const name = requireId(input?.name, 'Datos inválidos')

      const { error } = await supabase.from('product_promotions').insert({
        product_id: productId,
        name,
        unit_name: input?.unit_name || null,
        customer_group: input?.customer_group || null,
        promo_type: input?.promo_type || 'percent',
        promo_value: Number((input as any)?.promo_value || 0),
        min_qty_base: Number((input as any)?.min_qty_base || 1),
        starts_at: (input as any)?.starts_at || null,
        ends_at: (input as any)?.ends_at || null,
        priority: Number((input as any)?.priority || 100),
        active: (input as any)?.active !== false
      })
      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      return { ok: true as const }
    },

    async updatePromotion(id: string, input: Omit<PromotionInput, 'product_id'>) {
      const promoId = requireId(id, 'ID inválido')
      const name = (input as any)?.name ? String((input as any).name).trim() : undefined

      const { error } = await supabase
        .from('product_promotions')
        .update({
          name,
          unit_name: (input as any)?.unit_name || null,
          customer_group: (input as any)?.customer_group || null,
          promo_type: (input as any)?.promo_type || 'percent',
          promo_value: Number((input as any)?.promo_value || 0),
          min_qty_base: Number((input as any)?.min_qty_base || 1),
          starts_at: (input as any)?.starts_at || null,
          ends_at: (input as any)?.ends_at || null,
          priority: Number((input as any)?.priority || 100),
          active: (input as any)?.active !== false
        })
        .eq('id', promoId)
      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      return { ok: true as const }
    },

    async deletePromotion(id: string) {
      const promoId = requireId(id, 'ID inválido')
      const { error } = await supabase.from('product_promotions').delete().eq('id', promoId)
      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      return { ok: true as const }
    },

    async createCustomerGroupPrice(input: CustomerGroupPriceInput) {
      const productId = requireId(input?.product_id, 'Producto inválido')
      const { error } = await supabase.from('product_customer_group_prices').insert({
        product_id: productId,
        customer_group: input?.customer_group || null,
        unit_price_base: Number((input as any)?.unit_price_base || 0),
        priority: Number((input as any)?.priority || 100),
        active: (input as any)?.active !== false
      })
      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      return { ok: true as const }
    },

    async updateCustomerGroupPrice(id: string, input: Omit<CustomerGroupPriceInput, 'product_id'>) {
      const priceId = requireId(id, 'ID inválido')
      const { error } = await supabase
        .from('product_customer_group_prices')
        .update({
          customer_group: (input as any)?.customer_group || null,
          unit_price_base: Number((input as any)?.unit_price_base || 0),
          priority: Number((input as any)?.priority || 100),
          active: (input as any)?.active !== false
        })
        .eq('id', priceId)
      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      return { ok: true as const }
    },

    async deleteCustomerGroupPrice(id: string) {
      const priceId = requireId(id, 'ID inválido')
      const { error } = await supabase.from('product_customer_group_prices').delete().eq('id', priceId)
      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      return { ok: true as const }
    }
  }
}
