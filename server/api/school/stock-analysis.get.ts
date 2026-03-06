import { defineEventHandler, getQuery, createError } from 'h3'
import { getSupabaseAdminClient } from '../../utils/supabase'

type VariantType = 'default' | 'economic' | 'premium'
const MISSING_ITEMS_TOLERANCE_PCT = 0.2

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
          id, brand, is_default,
          product:products(id, sku, name, sale_price, stock_on_hand, unit)
        )
      )
    `)
    .eq('id', query.list_id)
    .single()

  if (error || !listData) throw createError({ statusCode: 404, statusMessage: 'Lista no encontrada' })

  let total_price = { default: 0, economic: 0, premium: 0 }
  let completable_sets_arr = { default: [] as number[], economic: [] as number[], premium: [] as number[] }
  let items_with_product = { default: 0, economic: 0, premium: 0 }
  let items_with_stock = { default: 0, economic: 0, premium: 0 }
  let total_items = listData.items?.length || 0

  const items = listData.items?.sort((a: any, b: any) => a.sort_order - b.sort_order).map((item: any) => {
    const qty_needed = item.qty || 1

    // Determine the products for each variant
    const defaultBrand = item.brands?.find((b: any) => b.is_default) || item.brands?.[0]
    
    // Find min and max priced brands
    let minPriceBrand = defaultBrand
    let maxPriceBrand = defaultBrand
    
    if (item.brands && item.brands.length > 0) {
      item.brands.forEach((b: any) => {
        if (!b.product || !b.product.sale_price) return
        
        if (!minPriceBrand?.product?.sale_price || b.product.sale_price < minPriceBrand.product.sale_price) {
          minPriceBrand = b
        }
        if (!maxPriceBrand?.product?.sale_price || b.product.sale_price > maxPriceBrand.product.sale_price) {
          maxPriceBrand = b
        }
      })
    }

    const variants = {
      default: defaultBrand?.product,
      economic: minPriceBrand?.product,
      premium: maxPriceBrand?.product
    }

    const brandNames = {
      default: defaultBrand?.brand,
      economic: minPriceBrand?.brand,
      premium: maxPriceBrand?.brand
    }

    const item_subtotals = { default: 0, economic: 0, premium: 0 }
    const match_statuses = { default: 'no_match', economic: 'no_match', premium: 'no_match' }

    // Process each variant
    ;(['default', 'economic', 'premium'] as VariantType[]).forEach(v => {
      const product = variants[v]
      
      if (product) {
        items_with_product[v]++
        const price = product.sale_price || 0
        const stock = product.stock_on_hand || 0
        
        item_subtotals[v] = price * qty_needed
        total_price[v] += item_subtotals[v]

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
      const product = variants[v]
      if (!product) return null
      return {
        id: product.id,
        sku: product.sku,
        name: product.name,
        brand: brandNames[v],
        sale_price: product.sale_price,
        stock_on_hand: product.stock_on_hand,
        unit: product.unit
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
            subtotal: item_subtotals.default,
            match_status: match_statuses.default
        },
        economic: {
            linked_product: buildLinkedProduct('economic'),
            subtotal: item_subtotals.economic,
            match_status: match_statuses.economic
        },
        premium: {
            linked_product: buildLinkedProduct('premium'),
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
      completable_sets: defaultCompletableSets,
      realizable_value: defaultCompletableSets * total_price.default,
      coverage_pct: total_items > 0 ? (items_with_product.default / total_items) * 100 : 0,
      items_with_product: items_with_product.default,
    },
    economic: {
      total_price: total_price.economic,
      completable_sets: economicCompletableSets,
      realizable_value: economicCompletableSets * total_price.economic,
      coverage_pct: total_items > 0 ? (items_with_product.economic / total_items) * 100 : 0,
      items_with_product: items_with_product.economic,
    },
    premium: {
      total_price: total_price.premium,
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
