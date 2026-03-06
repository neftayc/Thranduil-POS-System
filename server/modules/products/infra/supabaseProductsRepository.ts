import { createError } from 'h3'
import { randomUUID } from 'node:crypto'

import type { ProductsPageResult, ProductsRepository, ReplaceConversionsInput, UpsertProductCatalogInput } from '../ports'
import { getSupabaseUserClient } from '../../../utils/supabase'

export const makeSupabaseProductsRepository = (accessToken: string): ProductsRepository => {
  const supabase = getSupabaseUserClient(accessToken)
  const normalizeSku = (value: unknown) =>
    String(value || '')
      .trim()
      .toUpperCase()

  const skuBaseFromName = (name: string) =>
    String(name || '')
      .toUpperCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Z0-9]+/g, '')
      .slice(0, 8) || 'ITEM'

  const generateSkuCandidate = (name: string) => {
    const base = skuBaseFromName(name)
    const tail = randomUUID()
      .split('-')[0]
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 8)
    return `SKU-${base}-${tail || Date.now().toString(36).toUpperCase()}`
  }

  const ensureAutoSku = async (name: string) => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const candidate = normalizeSku(generateSkuCandidate(name))
      if (!candidate) continue

      const { data, error } = await supabase
        .from('product_catalog')
        .select('id')
        .eq('sku', candidate)
        .limit(1)

      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      if (!Array.isArray(data) || !data.length) {
        return candidate
      }
    }

    // Último fallback improbable; deja traza SKU igualmente único por timestamp.
    return normalizeSku(`SKU-${skuBaseFromName(name)}-${Date.now().toString(36).toUpperCase()}`)
  }

  return {
    async getPage(): Promise<ProductsPageResult> {
      const [unitsRes, categoriesRes, productsRes] = await Promise.all([
        supabase.from('uom_catalog').select('code, label').eq('active', true).order('label'),
        supabase.from('product_categories').select('id, code, name').eq('active', true).order('sort_order').order('name'),
        supabase
          .from('product_catalog')
          .select(
            'id, sku, name, brand, category_id, category_code, category_name, product_type, barcode, unit, sale_price, stock_on_hand, avg_cost, last_purchase_cost, fifo_stock_qty, fifo_stock_value, fifo_next_cost, needs_presentation_setup, missing_purchase_units, min_stock, active, created_at'
          )
          .order('name')
      ])

      if (unitsRes.error) throw createError({ statusCode: 500, statusMessage: unitsRes.error.message })
      if (categoriesRes.error) throw createError({ statusCode: 500, statusMessage: categoriesRes.error.message })
      if (productsRes.error) throw createError({ statusCode: 500, statusMessage: productsRes.error.message })

      const products = productsRes.data || []
      const productIds = products
        .map((item: any) => String(item?.id || '').trim())
        .filter((id: string) => Boolean(id))

      const fifoNextQtyByProduct = new Map<string, number>()
      const fifoNextCostByProduct = new Map<string, number>()
      const fifoPendingByProduct = new Map<string, boolean>()
      const lastCostByProduct = new Map<string, number>()

      const normalize = (value: any) => String(value || '').trim().toLowerCase()
      const units = unitsRes.data || []
      const uomAliases = new Map<string, string>()
      for (const row of units as any[]) {
        const code = normalize((row as any)?.code)
        const label = normalize((row as any)?.label)
        if (!code) continue
        uomAliases.set(code, code)
        if (label) uomAliases.set(label, code)
        if (label) uomAliases.set(`${label}s`, code)
        uomAliases.set(`${code}s`, code)
      }
      const resolveUom = (value: any) => {
        const key = normalize(value)
        if (!key) return 'unidad'
        return uomAliases.get(key) || key
      }

      if (productIds.length) {
        const [conversionsRes, purchasesRes] = await Promise.all([
          supabase
            .from('product_unit_conversions')
            .select('product_id, unit_name, factor_to_base')
            .in('product_id', productIds)
            .eq('is_active', true),
          supabase
            .from('purchase_items')
            .select('id, product_id, unit_name, qty_uom, cost_unit_uom, total_cost, created_at, purchases (invoice_no, purchase_date, created_at)')
            .in('product_id', productIds)
        ])

        if (conversionsRes.error) throw createError({ statusCode: 500, statusMessage: conversionsRes.error.message })
        if (purchasesRes.error) throw createError({ statusCode: 500, statusMessage: purchasesRes.error.message })

        const factorByProductAndUnit = new Map<string, number>()
        for (const row of conversionsRes.data || []) {
          const productId = String((row as any)?.product_id || '').trim()
          const unitCode = resolveUom((row as any)?.unit_name)
          const factor = Number((row as any)?.factor_to_base || 0)
          if (!productId || !unitCode || !Number.isFinite(factor) || factor <= 0) continue
          factorByProductAndUnit.set(`${productId}::${unitCode}`, factor)
        }

        const baseUnitByProduct = new Map<string, string>()
        const stockByProduct = new Map<string, number>()
        for (const product of products) {
          const id = String((product as any)?.id || '').trim()
          if (!id) continue
          baseUnitByProduct.set(id, resolveUom((product as any)?.unit))
          stockByProduct.set(id, Math.max(0, Number((product as any)?.stock_on_hand || 0)))
        }

        type PurchaseLine = { qtyBase: number; costBase: number; orderKey: string }
        const purchasesByProduct = new Map<string, PurchaseLine[]>()
        const invoiceRank = (invoiceNo: string) => {
          const normalized = normalize(invoiceNo)
          if (normalized.includes('import-hoja1-tania-yucra-001')) return 0
          if (normalized.includes('import-hoja1-empresa-ayrampo-001')) return 1
          return 50
        }
        for (const row of purchasesRes.data || []) {
          const productId = String((row as any)?.product_id || '').trim()
          if (!productId) continue

          const qtyUom = Number((row as any)?.qty_uom || 0)
          if (!Number.isFinite(qtyUom) || qtyUom <= 0) continue

          const unitCode = resolveUom((row as any)?.unit_name)
          const baseUnit = baseUnitByProduct.get(productId) || 'unidad'
          const factor =
            unitCode === baseUnit ? 1 : Number(factorByProductAndUnit.get(`${productId}::${unitCode}`) || 0)
          if (!Number.isFinite(factor) || factor <= 0) continue

          const qtyBase = qtyUom * factor
          if (qtyBase <= 0) continue
          const totalCost = Number((row as any)?.total_cost || 0)
          const costUnitUom = Number((row as any)?.cost_unit_uom || 0)
          const costBase =
            totalCost > 0 ? totalCost / qtyBase : costUnitUom > 0 ? costUnitUom / factor : 0

          const purchaseDate = String(((row as any)?.purchases as any)?.purchase_date || '')
          const purchaseCreatedAt = String(((row as any)?.purchases as any)?.created_at || '')
          const invoiceNo = String(((row as any)?.purchases as any)?.invoice_no || '')
          const itemCreatedAt = String((row as any)?.created_at || '')
          const id = String((row as any)?.id || '')
          const rank = String(invoiceRank(invoiceNo)).padStart(3, '0')
          const orderKey = `${purchaseDate}|${purchaseCreatedAt}|${rank}|${invoiceNo}|${itemCreatedAt}|${id}`

          const list = purchasesByProduct.get(productId) || []
          list.push({ qtyBase, costBase, orderKey })
          purchasesByProduct.set(productId, list)
        }

        for (const productId of productIds) {
          const lines = (purchasesByProduct.get(productId) || []).sort((a, b) => a.orderKey.localeCompare(b.orderKey))
          const lastLine = lines.length ? lines[lines.length - 1] : null
          if (lastLine) {
            lastCostByProduct.set(productId, Number((lastLine.costBase || 0).toFixed(4)))
          }
          const purchasedTotal = lines.reduce((sum, line) => sum + Number(line.qtyBase || 0), 0)
          const stockCurrent = Number(stockByProduct.get(productId) || 0)
          const consumedBase = Math.max(0, purchasedTotal - stockCurrent)
          let remainingToConsume = consumedBase
          let nextQty = 0
          let nextCost = 0
          let isPending = false

          for (const line of lines) {
            const consume = Math.max(0, Math.min(line.qtyBase, remainingToConsume))
            const remaining = line.qtyBase - consume
            remainingToConsume = Math.max(0, remainingToConsume - line.qtyBase)
            if (remaining > 0.0005) {
              nextQty = remaining
              nextCost = line.costBase
              isPending = consumedBase > 0.0005 && remaining < line.qtyBase - 0.0005 && remaining < stockCurrent - 0.0005
              break
            }
          }
          fifoNextQtyByProduct.set(productId, Number(nextQty.toFixed(3)))
          fifoNextCostByProduct.set(productId, Number(nextCost.toFixed(4)))
          fifoPendingByProduct.set(productId, isPending)
        }
      }

      return {
        units: units,
        categories: categoriesRes.data || [],
        products: products.map((item: any) => ({
          ...item,
          last_purchase_cost:
            lastCostByProduct.get(String(item?.id || '').trim()) ?? Number(item?.last_purchase_cost || 0),
          fifo_next_cost:
            Number(fifoNextQtyByProduct.get(String(item?.id || '').trim()) || 0) > 0
              ? fifoNextCostByProduct.get(String(item?.id || '').trim()) ?? Number(item?.fifo_next_cost || 0)
              : Number(item?.fifo_next_cost || 0),
          fifo_next_qty: fifoNextQtyByProduct.get(String(item?.id || '').trim()) ?? 0,
          fifo_has_pending: fifoPendingByProduct.get(String(item?.id || '').trim()) ?? false
        }))
      }
    },

    async upsertCatalog(input: UpsertProductCatalogInput) {
      const name = String(input?.p_name || '').trim()
      if (!name) {
        throw createError({ statusCode: 400, statusMessage: 'Nombre obligatorio' })
      }
      const isCreate = !String(input?.p_id || '').trim()
      let skuForPayload = normalizeSku(input?.p_sku)
      if (isCreate && !skuForPayload) {
        skuForPayload = await ensureAutoSku(name)
      }

      const payload = {
        p_id: input?.p_id || null,
        p_sku: skuForPayload || null,
        p_name: name,
        p_unit: input?.p_unit || 'unidad',
        p_brand: input?.p_brand || null,
        p_product_type: input?.p_category_name || null,
        p_barcode: input?.p_barcode || null,
        p_active: input?.p_active !== false,
        p_sale_price: Number(input?.p_sale_price || 0),
        p_min_stock: Number(input?.p_min_stock || 0),
        p_stock_on_hand:
          input?.p_stock_on_hand === null || typeof input?.p_stock_on_hand === 'undefined'
            ? null
            : Number(input?.p_stock_on_hand || 0),
        p_avg_cost:
          input?.p_avg_cost === null || typeof input?.p_avg_cost === 'undefined' ? null : Number(input?.p_avg_cost || 0),
        p_currency: input?.p_currency || 'PEN'
      }

      const { data, error } = await supabase.rpc('upsert_product_catalog', payload)
      if (error) throw createError({ statusCode: 500, statusMessage: error.message })

      return { id: String(data) }
    },

    async replaceConversions(input: ReplaceConversionsInput) {
      const productId = String(input?.p_product_id || '').trim()
      if (!productId) {
        throw createError({ statusCode: 400, statusMessage: 'Producto inválido' })
      }

      const { error } = await supabase.rpc('replace_product_unit_conversions', {
        p_product_id: productId,
        p_items: (input as any)?.p_items ?? []
      })

      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      return { ok: true as const }
    },

    async getConversions(productId: string) {
      const id = String(productId || '').trim()
      if (!id) {
        throw createError({ statusCode: 400, statusMessage: 'Producto inválido' })
      }

      const { data, error } = await supabase
        .from('product_unit_conversions')
        .select('unit_name, factor_to_base, is_active')
        .eq('product_id', id)
        .order('unit_name')

      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      return { items: data || [] }
    }
  }
}
