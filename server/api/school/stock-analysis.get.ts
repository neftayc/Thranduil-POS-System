import { defineEventHandler, getQuery, createError } from 'h3'
import { getSupabaseAdminClient } from '../../utils/supabase'
import { resolveSchoolBrandPricing } from '../../utils/schoolPricing'

type VariantType = 'default' | 'economic' | 'premium'
const MISSING_ITEMS_TOLERANCE_PCT = 0.2

const normalizeId = (value: unknown) => String(value || '').trim()
const toNumber = (value: unknown) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const hasFifoPending = (product: any) => {
  const fifoQty = toNumber(product?.fifo_next_qty)
  const stock = toNumber(product?.stock_on_hand)
  if (fifoQty <= 0 || stock <= 0) return false
  return fifoQty < stock - 0.0005
}

const resolveFifoUnitCost = (product: any) => {
  if (!product) return 0

  if (!hasFifoPending(product)) {
    const lastCost = toNumber(product?.last_purchase_cost)
    if (lastCost > 0) return lastCost
  }

  const nextCost = toNumber(product?.fifo_next_cost)
  if (nextCost > 0) return nextCost

  const stockQty = toNumber(product?.fifo_stock_qty)
  if (stockQty > 0) {
    const stockValue = toNumber(product?.fifo_stock_value)
    if (stockValue > 0) return stockValue / stockQty
  }

  return Math.max(0, toNumber(product?.avg_cost))
}

const calculateCompletableSetsWithTolerance = (
  setsPerItem: number[],
  totalItems: number
) => {
  if (!setsPerItem.length || totalItems <= 0) return 0
  const allowedMissingItems = Math.min(
    setsPerItem.length - 1,
    Math.ceil(totalItems * MISSING_ITEMS_TOLERANCE_PCT)
  )
  const sortedSets = [...setsPerItem].sort((a, b) => a - b)
  return Math.max(0, sortedSets[allowedMissingItems] ?? 0)
}

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  if (!query.list_id) throw createError({ statusCode: 400, statusMessage: 'list_id requerido' })

  const supabase = getSupabaseAdminClient()

  const { data: listData, error } = await supabase
    .from('school_lists')
    .select(`
      id, year, active, notes,
      institution:institutions(name),
      grade:school_grades(name, level),
      section:school_sections(name),
      items:school_list_items(
        id, item_description, qty, sort_order, notes,
        brands:school_list_item_brands(
          id, brand, is_default, product_id,
          pricing_rule_id, pricing_unit_name, pricing_label, pricing_price_uom, pricing_factor_to_base
        )
      )
    `)
    .eq('id', query.list_id)
    .single()

  if (error || !listData) throw createError({ statusCode: 404, statusMessage: 'Lista no encontrada' })

  const productIds = Array.from(
    new Set(
      (listData.items || []).flatMap((item: any) =>
        (item.brands || [])
          .map((brand: any) => normalizeId(brand?.product_id))
          .filter((productId: string) => Boolean(productId))
      )
    )
  )

  const productById = new Map<string, any>()
  if (productIds.length) {
    const { data: productRows, error: productError } = await supabase
      .from('product_catalog')
      .select('id, sku, name, sale_price, stock_on_hand, unit, avg_cost, last_purchase_cost, fifo_stock_qty, fifo_stock_value, fifo_next_cost, fifo_next_qty')
      .in('id', productIds)

    if (productError) {
      throw createError({ statusCode: 500, statusMessage: productError.message })
    }

    for (const row of productRows || []) {
      const productId = normalizeId((row as any)?.id)
      if (!productId) continue
      productById.set(productId, row)
    }
  }

  let total_price = { default: 0, economic: 0, premium: 0 }
  let total_cost = { default: 0, economic: 0, premium: 0 }
  let total_profit = { default: 0, economic: 0, premium: 0 }
  let completable_sets_arr = { default: [] as number[], economic: [] as number[], premium: [] as number[] }
  let items_with_product = { default: 0, economic: 0, premium: 0 }
  let items_with_stock = { default: 0, economic: 0, premium: 0 }
  let total_items = listData.items?.length || 0

  const items = listData.items?.sort((a: any, b: any) => a.sort_order - b.sort_order).map((item: any) => {
    const qty_needed = item.qty || 1
    const brands = (item.brands || []).map((brand: any) => ({
      ...brand,
      product: productById.get(normalizeId(brand?.product_id)) || null
    }))

    const defaultBrand = brands.find((b: any) => b.is_default) || brands[0]
    let minPriceBrand = defaultBrand
    let maxPriceBrand = defaultBrand

    if (brands.length > 0) {
      brands.forEach((b: any) => {
        if (!b.product) return

        const currentPricing = resolveSchoolBrandPricing(b)
        const minPricing = minPriceBrand ? resolveSchoolBrandPricing(minPriceBrand) : null
        const maxPricing = maxPriceBrand ? resolveSchoolBrandPricing(maxPriceBrand) : null

        if (!minPricing || currentPricing.price_base < minPricing.price_base) {
          minPriceBrand = b
        }
        if (!maxPricing || currentPricing.price_base > maxPricing.price_base) {
          maxPriceBrand = b
        }
      })
    }

    const variantBrands = {
      default: defaultBrand || null,
      economic: minPriceBrand || null,
      premium: maxPriceBrand || null
    }

    const brandNames = {
      default: defaultBrand?.brand,
      economic: minPriceBrand?.brand,
      premium: maxPriceBrand?.brand
    }

    const item_subtotals = { default: 0, economic: 0, premium: 0 }
    const item_cost_totals = { default: 0, economic: 0, premium: 0 }
    const item_profit_totals = { default: 0, economic: 0, premium: 0 }
    const match_statuses = { default: 'no_match', economic: 'no_match', premium: 'no_match' }
    const item_qty_uom = { default: 0, economic: 0, premium: 0 }
    const item_factor_to_base = { default: 1, economic: 1, premium: 1 }
    const item_unit_name = { default: '', economic: '', premium: '' }

    ;(['default', 'economic', 'premium'] as VariantType[]).forEach(v => {
      const brand = variantBrands[v]
      const product = brand?.product

      if (product) {
        items_with_product[v]++
        const pricing = resolveSchoolBrandPricing(brand)
        const price = pricing.price_uom
        const fifoUnitCost = resolveFifoUnitCost(product)
        const stock = product.stock_on_hand || 0

        item_qty_uom[v] = pricing.qty_uom_from_base(qty_needed)
        item_factor_to_base[v] = pricing.factor_to_base
        item_unit_name[v] = pricing.unit_name
        item_subtotals[v] = pricing.subtotal_from_base(qty_needed)
        item_cost_totals[v] = fifoUnitCost * qty_needed
        item_profit_totals[v] = item_subtotals[v] - item_cost_totals[v]
        total_price[v] += item_subtotals[v]
        total_cost[v] += item_cost_totals[v]
        total_profit[v] += item_profit_totals[v]

        if (stock >= qty_needed) items_with_stock[v]++
        
        const sets_for_item = Math.floor(stock / qty_needed)
        completable_sets_arr[v].push(sets_for_item)

        if (stock >= qty_needed) {
          match_statuses[v] = 'ok'
        } else if (stock > 0) {
          match_statuses[v] = 'low'
        } else {
          match_statuses[v] = 'out_of_stock'
        }
      } else {
        completable_sets_arr[v].push(0)
      }
    })

    const buildLinkedProduct = (v: VariantType) => {
      const brand = variantBrands[v]
      const product = brand?.product
      if (!product || !brand) return null
      const pricing = resolveSchoolBrandPricing(brand)
      return {
        id: product.id,
        product_id: product.id,
        brand_id: brand.id,
        sku: product.sku,
        name: product.name,
        brand: brandNames[v],
        avg_cost: product.avg_cost,
        fifo_unit_cost: resolveFifoUnitCost(product),
        last_purchase_cost: product.last_purchase_cost,
        fifo_next_cost: product.fifo_next_cost,
        sale_price: pricing.price_uom,
        stock_on_hand: product.stock_on_hand,
        unit: pricing.unit_name,
        base_unit: product.unit,
        factor_to_base: pricing.factor_to_base,
        pricing_label: pricing.label,
        pricing_rule_id: pricing.rule_id,
      }
    }

    return {
      id: item.id,
      description: item.item_description,
      qty: item.qty,
      notes: item.notes,
      variants: {
        default: {
            linked_product: buildLinkedProduct('default'),
            qty_uom: item_qty_uom.default,
            factor_to_base: item_factor_to_base.default,
            unit_name: item_unit_name.default,
            cost_total: item_cost_totals.default,
            profit_total: item_profit_totals.default,
            subtotal: item_subtotals.default,
            match_status: match_statuses.default
        },
        economic: {
            linked_product: buildLinkedProduct('economic'),
            qty_uom: item_qty_uom.economic,
            factor_to_base: item_factor_to_base.economic,
            unit_name: item_unit_name.economic,
            cost_total: item_cost_totals.economic,
            profit_total: item_profit_totals.economic,
            subtotal: item_subtotals.economic,
            match_status: match_statuses.economic
        },
        premium: {
            linked_product: buildLinkedProduct('premium'),
            qty_uom: item_qty_uom.premium,
            factor_to_base: item_factor_to_base.premium,
            unit_name: item_unit_name.premium,
            cost_total: item_cost_totals.premium,
            profit_total: item_profit_totals.premium,
            subtotal: item_subtotals.premium,
            match_status: match_statuses.premium
        }
      }
    }
  })

  // Calculate metrics for each variant
  const defaultCompletableSets = calculateCompletableSetsWithTolerance(
    completable_sets_arr.default,
    total_items
  )
  const economicCompletableSets = calculateCompletableSetsWithTolerance(
    completable_sets_arr.economic,
    total_items
  )
  const premiumCompletableSets = calculateCompletableSetsWithTolerance(
    completable_sets_arr.premium,
    total_items
  )

  const metrics = {
    default: {
      total_price: total_price.default,
      total_cost: total_cost.default,
      total_profit: total_profit.default,
      completable_sets: defaultCompletableSets,
      realizable_value: defaultCompletableSets * total_price.default,
      coverage_pct: total_items > 0 ? (items_with_product.default / total_items) * 100 : 0,
      items_with_product: items_with_product.default,
    },
    economic: {
      total_price: total_price.economic,
      total_cost: total_cost.economic,
      total_profit: total_profit.economic,
      completable_sets: economicCompletableSets,
      realizable_value: economicCompletableSets * total_price.economic,
      coverage_pct: total_items > 0 ? (items_with_product.economic / total_items) * 100 : 0,
      items_with_product: items_with_product.economic,
    },
    premium: {
      total_price: total_price.premium,
      total_cost: total_cost.premium,
      total_profit: total_profit.premium,
      completable_sets: premiumCompletableSets,
      realizable_value: premiumCompletableSets * total_price.premium,
      coverage_pct: total_items > 0 ? (items_with_product.premium / total_items) * 100 : 0,
      items_with_product: items_with_product.premium,
    },
    total_items
  }

  return {
    list: {
      id: listData.id,
      institution_name: listData.institution ? (listData.institution as any).name : undefined,
      grade_name: listData.grade ? (listData.grade as any).name : undefined,
      grade_level: listData.grade ? (listData.grade as any).level : undefined,
      section_name: listData.section ? (listData.section as any).name : undefined,
      year: listData.year,
      notes: listData.notes
    },
    metrics,
    items: items || []
  }
})
