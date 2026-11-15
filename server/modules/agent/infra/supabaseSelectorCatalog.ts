import { createHash } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { SelectorCatalog, SelectorProduct } from '../app/salesSelector'

const env = (key: string) => (typeof process !== 'undefined' ? process.env[key] : undefined)

type Rows = {
  products: any[]
  conversions: any[]
  presentationPrices: any[]
  tiers: any[]
  payments: any[]
}

const page = async (db: SupabaseClient, table: string, columns: string, filter: (q: any) => any) => {
  const rows: any[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await filter(db.from(table).select(columns)).range(from, from + 999)
    if (error) throw error
    rows.push(...(data || []))
    if (!data || data.length < 1000) return rows
  }
}

/** READ-ONLY queries: active products, presentations, presentation prices, wholesale tiers and payment methods. No costs. */
export const readSelectorRows = async (db: SupabaseClient): Promise<Rows> => {
  const now = new Date().toISOString()
  const live = (q: any) => q.eq('active', true).is('customer_group', null).or(`starts_at.is.null,starts_at.lte.${now}`).or(`ends_at.is.null,ends_at.gte.${now}`)
  const [products, conversions, presentationPrices, tiers, payments] = await Promise.all([
    page(db, 'product_catalog', 'id, name, brand, product_type, unit, sale_price, stock_on_hand, updated_at', q => q.eq('active', true).order('id')),
    page(db, 'product_unit_conversions', 'product_id, unit_name, factor_to_base', q => q.eq('is_active', true).order('id')),
    page(db, 'product_presentation_prices', 'product_id, unit_name, price_uom, priority', q => live(q).order('priority')),
    page(db, 'product_wholesale_tiers', 'product_id, min_qty_base, unit_price_base, priority', q => live(q).order('min_qty_base')),
    db.from('payment_method_catalog').select('code, label').eq('active', true).order('sort_order').then(({ data, error }) => { if (error) throw error; return data || [] })
  ])
  return { products, conversions, presentationPrices, tiers, payments }
}

/** Builds the compact selector catalog. `reserved` = base units held by live ventas por confirmar. */
export const buildSelectorCatalog = (rows: Rows, reserved: Map<string, number> = new Map()): SelectorCatalog => {
  const num = (v: unknown) => Number.isFinite(Number(v)) ? Number(v) : 0
  const presentationPrice = new Map<string, number>()
  for (const r of rows.presentationPrices) {
    const key = `${r.product_id}|${String(r.unit_name).toLowerCase()}`
    if (!presentationPrice.has(key)) presentationPrice.set(key, num(r.price_uom))
  }
  const conversions = new Map<string, Array<{ unit: string; factor: number }>>()
  for (const c of rows.conversions) conversions.set(c.product_id, [...(conversions.get(c.product_id) || []), { unit: String(c.unit_name), factor: num(c.factor_to_base) }])
  const tiers = new Map<string, Array<{ min_qty: number; price: number }>>()
  for (const t of rows.tiers) tiers.set(t.product_id, [...(tiers.get(t.product_id) || []), { min_qty: num(t.min_qty_base), price: num(t.unit_price_base) }])
  const products: SelectorProduct[] = rows.products.map(p => {
    const unit = String(p.unit || 'unidad')
    const base = num(p.sale_price)
    const priceOf = (u: string, factor: number) => presentationPrice.get(`${p.id}|${u.toLowerCase()}`) ?? (base > 0 ? base * factor : null)
    const extra = (conversions.get(p.id) || []).filter(c => c.unit.toLowerCase() !== unit.toLowerCase())
    return {
      id: p.id,
      name: String(p.name),
      brand: p.brand ? String(p.brand).replace(/,+$/, '').trim() || null : null,
      type: p.product_type ? String(p.product_type) : null,
      unit,
      presentations: [{ unit, factor: 1, price: priceOf(unit, 1) }, ...extra.map(c => ({ unit: c.unit, factor: c.factor, price: priceOf(c.unit, c.factor) }))],
      tiers: (tiers.get(p.id) || []).sort((a, b) => a.min_qty - b.min_qty),
      stock: Math.max(0, num(p.stock_on_hand) - (reserved.get(p.id) || 0))
    }
  })
  const payment_methods = rows.payments.map((p: any) => ({ code: String(p.code), label: String(p.label) }))
  // Version = hash of the content: the fixed prompt prefix (and the provider's cache) only changes when something shown changes.
  const version = createHash('sha256').update(JSON.stringify([products, payment_methods])).digest('hex').slice(0, 16)
  return { products, payment_methods, version }
}

/**
 * Catalog for the selector, cached in memory. Products are re-read at once when the newest
 * `updated_at` changes (cheap check every `checkEveryMs`), and at least every `refreshMs` so the
 * stock follows the sales; the stock always discounts the current reservations.
 */
export const makeSupabaseSelectorCatalog = (options: { db?: SupabaseClient; reserved?: () => Promise<Map<string, number>>; checkEveryMs?: number; refreshMs?: number } = {}) => {
  const db = options.db || createClient(String(env('SUPABASE_URL') || env('NUXT_PUBLIC_SUPABASE_URL')), String(env('SUPABASE_SERVICE_ROLE')), { auth: { persistSession: false } })
  let rows: Rows | null = null
  let stamp = ''
  let checkedAt = 0
  let readAt = 0
  return async (): Promise<SelectorCatalog> => {
    if (!rows || Date.now() - checkedAt > (options.checkEveryMs ?? 30_000)) {
      const { data, error } = await db.from('products').select('updated_at').order('updated_at', { ascending: false }).limit(1)
      if (error) throw error
      const latest = String(data?.[0]?.updated_at || '')
      if (!rows || latest !== stamp || Date.now() - readAt > (options.refreshMs ?? 120_000)) { rows = await readSelectorRows(db); stamp = latest; readAt = Date.now() }
      checkedAt = Date.now()
    }
    let reserved = new Map<string, number>()
    try { if (options.reserved) reserved = await options.reserved() } catch { /* stock without reservations; the registrar re-checks it */ }
    return buildSelectorCatalog(rows, reserved)
  }
}
