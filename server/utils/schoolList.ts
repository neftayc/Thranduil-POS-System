import type { MatchedLine, ProductOption } from './aiLogic'

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export type Institution = {
  id: string
  name: string
  short_name: string | null
}

export type SchoolGrade = {
  id: string
  institution_id: string
  level: 'inicial' | 'primaria' | 'secundaria'
  name: string
  sort_order: number
}

export type SchoolSection = {
  id: string
  grade_id: string
  name: string
}

export type SchoolListItem = {
  id: string
  item_description: string
  qty: number
  notes: string | null
  sort_order: number
  brands: {
    id: string
    brand: string
    is_default: boolean
    product: {
      id: string
      sku: string
      name: string
      unit: string
      sale_price: number
      stock_on_hand: number
    }
  }[]
}

// ─────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────

export const getActiveInstitutions = async (supabase: any): Promise<Institution[]> => {
  const { data, error } = await supabase
    .from('institutions')
    .select('id, name, short_name')
    .eq('active', true)
    .order('name')

  if (error) throw new Error(`Error fetching institutions: ${error.message}`)
  return data || []
}

export const getGradesByInstitution = async (
  supabase: any,
  institutionId: string
): Promise<SchoolGrade[]> => {
  const { data, error } = await supabase
    .from('school_grades')
    .select('id, institution_id, level, name, sort_order')
    .eq('institution_id', institutionId)
    .eq('active', true)
    .order('sort_order')

  if (error) throw new Error(`Error fetching grades: ${error.message}`)
  return data || []
}

export const getSectionsByGrade = async (
  supabase: any,
  gradeId: string
): Promise<SchoolSection[]> => {
  const { data, error } = await supabase
    .from('school_sections')
    .select('id, grade_id, name')
    .eq('grade_id', gradeId)
    .eq('active', true)
    .order('name')

  if (error) throw new Error(`Error fetching sections: ${error.message}`)
  return data || []
}

/**
 * Returns the most recent active school list for an institution/grade/section combination.
 */
export const getActiveSchoolList = async (
  supabase: any,
  institutionId: string,
  gradeId: string,
  sectionId: string
): Promise<{ id: string; year: number } | null> => {
  const { data, error } = await supabase
    .from('school_lists')
    .select('id, year')
    .eq('institution_id', institutionId)
    .eq('grade_id', gradeId)
    .eq('section_id', sectionId)
    .eq('active', true)
    .order('year', { ascending: false })
    .limit(1)
    .single()

  if (error && error.code !== 'PGRST116') {
    throw new Error(`Error fetching school list: ${error.message}`)
  }
  return data || null
}

/**
 * Returns all items (with their brand/product variants) for a school list.
 */
export const getSchoolListItems = async (
  supabase: any,
  listId: string
): Promise<SchoolListItem[]> => {
  const { data, error } = await supabase
    .from('school_list_items')
    .select(`
      id,
      item_description,
      qty,
      notes,
      sort_order,
      school_list_item_brands (
        id,
        brand,
        is_default,
        products (
          id, sku, name, unit, sale_price, stock_on_hand
        )
      )
    `)
    .eq('list_id', listId)
    .order('sort_order')

  if (error) throw new Error(`Error fetching school list items: ${error.message}`)

  // Reshape the nested data for convenience
  return (data || []).map((item: any) => ({
    id: item.id,
    item_description: item.item_description,
    qty: item.qty,
    notes: item.notes,
    sort_order: item.sort_order,
    brands: (item.school_list_item_brands || []).map((b: any) => ({
      id: b.id,
      brand: b.brand,
      is_default: b.is_default,
      product: b.products
    }))
  }))
}

// ─────────────────────────────────────────────
// Cart Builder (pure DB — no AI)
// ─────────────────────────────────────────────

/**
 * Builds a MatchedLine[] cart from a school list, prioritizing the client's preferred brands.
 * Falls back to the is_default product if no preferred brand is found.
 * No AI is used — all lookups are pure DB data.
 */
export const buildCartFromSchoolList = (
  items: SchoolListItem[],
  brandPreferences: string[]  // e.g. ["Faber Castell", "Layconsa"]
): MatchedLine[] => {
  // Normalize preferences for case-insensitive comparison
  const normalizedPrefs = brandPreferences.map(b => b.toLowerCase().trim())

  return items.map(item => {
    // 1. Try preferred brands in order of preference
    let selectedBrand = normalizedPrefs.length > 0
      ? item.brands.find(b =>
          normalizedPrefs.some(pref =>
            b.brand.toLowerCase().includes(pref) || pref.includes(b.brand.toLowerCase())
          )
        )
      : undefined

    // 2. Fallback: cheapest available brand (client hasn't specified or brand not found)
    if (!selectedBrand) {
      selectedBrand = [...item.brands]
        .filter(b => b.product)
        .sort((a, b) => Number(a.product.sale_price) - Number(b.product.sale_price))[0]
    }

    if (!selectedBrand || !selectedBrand.product) {
      // No product configured yet for this item
      return {
        requested_item: item.item_description,
        requested_qty: item.qty,
        raw: item.item_description,
        best_match: null,
        alternatives: [],
        stock_status: 'no_match' as const
      }
    }

    const p = selectedBrand.product
    const stockOk = Number(p.stock_on_hand) >= item.qty

    const bestMatch: ProductOption = {
      product_id: p.id,
      sku: p.sku,
      name: p.name,
      unit: p.unit,
      sale_price: Number(p.sale_price),
      stock_on_hand: Number(p.stock_on_hand),
      score: 1
    }

    // Collect alternatives (other brands for this same item)
    const alternatives: ProductOption[] = item.brands
      .filter(b => b.id !== selectedBrand!.id && b.product)
      .map(b => ({
        product_id: b.product.id,
        sku: b.product.sku,
        name: b.product.name,
        unit: b.product.unit,
        sale_price: Number(b.product.sale_price),
        stock_on_hand: Number(b.product.stock_on_hand),
        score: 0.9
      }))

    return {
      requested_item: item.item_description,
      requested_qty: item.qty,
      raw: item.item_description,
      best_match: bestMatch,
      alternatives,
      stock_status: stockOk ? 'ok' : ('low' as const)
    }
  })
}

/**
 * Parse brand preferences from a free-text client message.
 * e.g. "Faber Castell y Layconsa" → ["Faber Castell", "Layconsa"]
 * e.g. "cualquiera" → []
 */
export const parseBrandPreferences = (text: string): string[] => {
  const normalized = text.toLowerCase().trim()
  if (['cualquiera', 'cualquier', 'indiferente', 'no importa', 'da igual'].includes(normalized)) {
    return []
  }

  // Split by common separators: "y", ",", "/", "&"
  return text
    .split(/\s*[,/&]\s*|\s+y\s+/i)
    .map(b => b.trim())
    .filter(b => b.length > 2)
}
