import { defineEventHandler, createError } from 'h3'
import { getSupabaseAdminClient } from '../../utils/supabase'

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
  const supabase = getSupabaseAdminClient()

  const { data: lists, error } = await supabase
    .from('school_lists')
    .select(`
      id, year, active, notes,
      institution:institutions(name),
      grade:school_grades(name, level),
      section:school_sections(name),
      items:school_list_items(
        id, item_description, qty,
        brands:school_list_item_brands(
          is_default,
          product:products(id, name, sale_price, stock_on_hand)
        )
      )
    `)
    .eq('active', true)

  if (error) throw createError({ statusCode: 500, statusMessage: error.message })

  const result = (lists || []).map((list: any) => {
    let price_min = 0 // Sum of the cheapest product for each item
    let price_max = 0 // Sum of the most expensive product for each item
    let total_price = 0 // Sum of the default products
    let completable_sets_arr: number[] = []
    let items_with_product = 0
    let items_with_stock = 0
    let total_items = list.items?.length || 0

    list.items?.forEach((item: any) => {
      // Find default brand or first available
      const defaultBrand = item.brands?.find((b: any) => b.is_default) || item.brands?.[0]
      const product = defaultBrand?.product

      // Price ranges calculation using all available brands for the item
      const qty_needed = item.qty || 1
      const item_prices = item.brands
          ?.filter((b: any) => b.product && b.product.sale_price)
          .map((b: any) => b.product.sale_price) || []

      if (item_prices.length > 0) {
        price_min += Math.min(...item_prices) * qty_needed
        price_max += Math.max(...item_prices) * qty_needed
      }

      if (product) {
        items_with_product++
        const price = product.sale_price || 0
        const stock = product.stock_on_hand || 0

        total_price += price * qty_needed

        if (stock >= qty_needed) {
          items_with_stock++
        }

        const sets_for_item = Math.floor(stock / qty_needed)
        completable_sets_arr.push(sets_for_item)
      } else {
        completable_sets_arr.push(0) // If an item has no product linked, we can't complete any sets
      }
    })

    const completable_sets = calculateCompletableSetsWithTolerance(
      completable_sets_arr,
      total_items
    )
    const coverage_pct = total_items > 0 ? (items_with_product / total_items) * 100 : 0
    const realizable_value = completable_sets * total_price

    let score = realizable_value * 0.5 + coverage_pct * 10 + completable_sets * 5
    let badge: string | null = null

    return {
      id: list.id,
      institution_name: list.institution?.name,
      grade_name: list.grade?.name,
      grade_level: list.grade?.level,
      section_name: list.section?.name,
      year: list.year,
      total_price,
      price_min,
      price_max,
      completable_sets,
      realizable_value,
      coverage_pct,
      total_items,
      items_with_product,
      score,
      badge
    }
  })

  // Sort by score descending
  result.sort((a, b) => b.score - a.score)

  if (result.length > 0) {
    // top 1 gets ⭐ Mayor retorno if score is decent
    if (result[0].score > 0) {
      result[0].badge = '⭐ Mayor retorno'
    }
    
    // items with good coverage but 0 completable sets = 📦 Sugiere restock
    result.forEach((r, i) => {
      if (i > 0 && r.coverage_pct >= 80 && r.completable_sets === 0) {
        if (!r.badge) r.badge = '📦 Sugiere restock'
      }
      if (i > 0 && r.completable_sets >= 10) {
         if (!r.badge) r.badge = '🔥 Alta rotación'
      }
    })
  }

  return result
})
