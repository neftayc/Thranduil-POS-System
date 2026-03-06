import { createError } from 'h3'

import type {
  CreatePurchaseInput,
  PurchasesPageResult,
  PurchasesRepository,
  UpdatePurchaseItemsInput
} from '../ports'
import { getSupabaseUserClient } from '../../../utils/supabase'

export const makeSupabasePurchasesRepository = (accessToken: string): PurchasesRepository => {
  const supabase = getSupabaseUserClient(accessToken)

  return {
    async getPage(): Promise<PurchasesPageResult> {
      const [uomRes, suppliersRes, productsRes, conversionsRes, historyRes] = await Promise.all([
        supabase.from('uom_catalog').select('code, label').eq('active', true).order('label'),
        supabase.from('suppliers').select('id, name').order('name'),
        supabase.from('product_catalog').select('id, name, unit, avg_cost').order('name'),
        supabase
          .from('product_unit_conversions')
          .select('product_id, unit_name, factor_to_base, is_active')
          .eq('is_active', true),
        supabase
          .from('purchases')
          .select(
            `
        id,
        invoice_no,
        purchase_date,
        total_cost,
        created_at,
        suppliers (name),
        purchase_items (
          id,
          product_id,
          unit_name,
          qty_uom,
          factor_to_base,
          cost_unit_uom,
          qty,
          cost_unit,
          total_cost,
          products (name, unit)
        )
      `
          )
          .order('created_at', { ascending: false })
          .limit(50)
      ])

      if (uomRes.error) throw createError({ statusCode: 500, statusMessage: uomRes.error.message })
      if (suppliersRes.error) throw createError({ statusCode: 500, statusMessage: suppliersRes.error.message })
      if (productsRes.error) throw createError({ statusCode: 500, statusMessage: productsRes.error.message })
      if (conversionsRes.error) throw createError({ statusCode: 500, statusMessage: conversionsRes.error.message })
      if (historyRes.error) throw createError({ statusCode: 500, statusMessage: historyRes.error.message })

      return {
        uomCatalog: uomRes.data || [],
        suppliers: suppliersRes.data || [],
        products: productsRes.data || [],
        conversions: conversionsRes.data || [],
        history: historyRes.data || []
      }
    },

    async createPurchase(input: CreatePurchaseInput) {
      const items = Array.isArray(input?.items) ? input.items : []
      if (!items.length) {
        throw createError({ statusCode: 400, statusMessage: 'Items inválidos' })
      }

      const { error } = await supabase.rpc('create_purchase', {
        p_supplier_id: input?.supplier_id || null,
        p_invoice_no: input?.invoice_no || null,
        p_items: items
      })

      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      return { ok: true as const }
    },

    async updatePurchaseItems(input: UpdatePurchaseItemsInput) {
      const purchaseId = String(input?.purchase_id || '').trim()
      const items = Array.isArray(input?.items) ? input.items : []

      if (!purchaseId) {
        throw createError({ statusCode: 400, statusMessage: 'Compra inválida' })
      }
      if (!items.length) {
        throw createError({ statusCode: 400, statusMessage: 'Items inválidos' })
      }

      const existingRes = await supabase
        .from('purchase_items')
        .select('id, product_id')
        .eq('purchase_id', purchaseId)

      if (existingRes.error) {
        throw createError({ statusCode: 500, statusMessage: existingRes.error.message })
      }

      const existingById = new Map<string, { id: string; product_id: string }>()
      for (const row of existingRes.data || []) {
        const id = String(row.id || '')
        const productId = String(row.product_id || '')
        if (!id || !productId) continue
        existingById.set(id, { id, product_id: productId })
      }

      const payload: Array<{
        id: string
        unit_name: string
        qty_uom: number
        cost_unit_uom: number
        total_cost: number
      }> = []

      for (const raw of items) {
        const itemId = String(raw?.id || '').trim()
        const qtyInput = Number(raw?.qty || 0)
        const costInput = Number(raw?.cost_unit || 0)
        const unitName = String(raw?.unit_name || '')
          .toLowerCase()
          .trim()

        if (!itemId || !existingById.has(itemId)) {
          throw createError({ statusCode: 400, statusMessage: 'Detalle de compra inválido' })
        }
        if (!unitName) {
          throw createError({ statusCode: 400, statusMessage: 'Unidad inválida' })
        }
        if (!Number.isFinite(qtyInput) || qtyInput <= 0) {
          throw createError({ statusCode: 400, statusMessage: 'Cantidad inválida' })
        }
        if (!Number.isFinite(costInput) || costInput < 0) {
          throw createError({ statusCode: 400, statusMessage: 'Costo inválido' })
        }

        const current = existingById.get(itemId)!
        if (!current.product_id) {
          throw createError({ statusCode: 400, statusMessage: 'Producto inválido en detalle de compra' })
        }

        payload.push({
          id: itemId,
          unit_name: unitName,
          qty_uom: Number(qtyInput.toFixed(3)),
          cost_unit_uom: Number(costInput.toFixed(4)),
          total_cost: Number((qtyInput * costInput).toFixed(2))
        })
      }

      for (const row of payload) {
        const updateRes = await supabase
          .from('purchase_items')
          .update({
            unit_name: row.unit_name,
            qty_uom: row.qty_uom,
            cost_unit_uom: row.cost_unit_uom,
            total_cost: row.total_cost
          })
          .eq('id', row.id)
          .eq('purchase_id', purchaseId)

        if (updateRes.error) {
          throw createError({ statusCode: 500, statusMessage: updateRes.error.message })
        }
      }

      const totalRes = await supabase
        .from('purchase_items')
        .select('total_cost')
        .eq('purchase_id', purchaseId)

      if (totalRes.error) {
        throw createError({ statusCode: 500, statusMessage: totalRes.error.message })
      }

      const nextTotal = Number(
        (totalRes.data || []).reduce((sum, item: any) => sum + Number(item?.total_cost || 0), 0).toFixed(2)
      )
      const purchaseRes = await supabase
        .from('purchases')
        .update({ total_cost: nextTotal })
        .eq('id', purchaseId)

      if (purchaseRes.error) {
        throw createError({ statusCode: 500, statusMessage: purchaseRes.error.message })
      }

      return { ok: true as const }
    }
  }
}
