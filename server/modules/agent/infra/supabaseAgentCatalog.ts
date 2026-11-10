import { getSupabaseAdminClient } from '../../../utils/supabase'
import type { AgentCatalog } from '../app/prepareSale'
import type { ValidationCatalog } from '../app/validateDraft'
import type { SearchCatalog } from '../app/legacyDraftBuilder'
import type { Product, StockLevel } from '../contracts'
import { brandVocabulary, decideMatch, retrieveLexical, type RetrievedDoc, type SearchDoc } from '../app/productSearch'
import type { Embedder } from './openaiEmbeddings'
import { makeProductSearchIndexer } from './productSearchIndexer'

const columns = 'id, name, sku, brand, unit, stock_on_hand'
const product = (row: any): Product => ({ id: row.id, name: row.name, sku: row.sku, brand: row.brand, unit: row.unit, stock: Number(row.stock_on_hand) })
// IDs from the AI draft are untrusted: a malformed one is "not found", not a database error.
const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
const stopwords = new Set(['de', 'del', 'el', 'la', 'los', 'las', 'un', 'una', 'con', 'para', 'hoja', 'hojas'])
const tokens = (text: string) => text.match(/[\p{L}\p{N}]+/gu)?.filter(term => !stopwords.has(term.toLowerCase())).slice(0, 16) || []

export type HybridSearchOptions = {
  /** Query/catalog embeddings. Without it the search is lexical only (still attribute-aware). */
  embed?: Embedder
  embeddingModel?: string
  /** Computes stale product vectors in the background, at most once per interval. */
  backgroundIndexIntervalMs?: number
}
const CACHE_MS = 60_000
const isMissingFunction = (error: any) => ['PGRST202', '42883', '42P01'].includes(String(error?.code || ''))

export const makeSupabaseAgentCatalog = (options: HybridSearchOptions = {}): AgentCatalog & ValidationCatalog & SearchCatalog & {
  stockLevels(ids: string[]): Promise<StockLevel[]>
  reindex(all?: boolean): Promise<{ embedded: number; skipped: number }>
} => {
  const db = getSupabaseAdminClient()
  let docsCache: { at: number; docs: SearchDoc[]; brands: Set<string> } | null = null
  let hybridAvailable = true
  let lastBackgroundIndex = 0
  const indexer = options.embed && options.embeddingModel ? makeProductSearchIndexer(db, options.embed, options.embeddingModel) : null

  // Active catalog for the brand vocabulary and the lexical fallback (no price/stock).
  const catalogDocs = async () => {
    if (docsCache && Date.now() - docsCache.at < CACHE_MS) return docsCache
    const docs: SearchDoc[] = []
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db.from('product_catalog').select('id, name, sku, brand, product_type').eq('active', true).range(from, from + 999)
      if (error) throw error
      docs.push(...(data || []).map((row: any) => ({ id: row.id, name: row.name, sku: row.sku, brand: row.brand, category: row.product_type })))
      if (!data || data.length < 1000) break
    }
    docsCache = { at: Date.now(), docs, brands: brandVocabulary(docs) }
    return docsCache
  }
  const backgroundIndex = () => {
    const interval = options.backgroundIndexIntervalMs ?? 60_000
    if (!indexer || !hybridAvailable || Date.now() - lastBackgroundIndex < interval) return
    lastBackgroundIndex = Date.now()
    indexer({ limit: 200 }).catch(() => { /* retried on the next search; the script reports errors */ })
  }
  const queryEmbedding = async (text: string) => {
    if (!options.embed) return null
    try {
      const [vector] = await Promise.race([
        options.embed([text]),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000))
      ])
      return vector
    } catch {
      return null // Vectors improve recall; exact signals still decide. Never block a sale on them.
    }
  }
  const searchProducts = async (text: string) => {
    const { docs, brands } = await catalogDocs()
    if (hybridAvailable) {
      const vector = await queryEmbedding(text)
      const { data, error } = await db.rpc('search_products_hybrid', {
        p_query: text, p_query_embedding: vector ? JSON.stringify(vector) : null, p_match_count: 40
      })
      if (!error) {
        backgroundIndex()
        const retrieved: RetrievedDoc[] = (data || []).map((row: any) => ({
          id: row.product_id, name: row.name, sku: row.sku, brand: row.brand, category: row.category, synonyms: row.synonyms || [],
          lexical_rank: row.lexical_rank, vector_rank: row.vector_rank, vector_similarity: row.vector_similarity
        }))
        // The trigram pass may miss heavy typos: complement with the in-memory lexical pass.
        const seen = new Set(retrieved.map(doc => doc.id))
        for (const doc of retrieveLexical(text, docs, 20)) if (!seen.has(doc.id)) retrieved.push({ ...doc, lexical_rank: null })
        return { docs: retrieved, brands }
      }
      if (!isMissingFunction(error)) throw error
      hybridAvailable = false // Migration not applied yet: lexical fallback.
    }
    return { docs: retrieveLexical(text, docs, 40), brands }
  }
  const getProducts = async (input: string[]) => {
    const ids = input.filter(isUuid)
    if (!ids.length) return []
    const { data, error } = await db.from('product_catalog').select(columns).eq('active', true).in('id', ids)
    if (error) throw error
    return (data || []).map(product)
  }

  return {
    searchProducts,
    getProducts,
    async reindex(all = false) {
      if (!indexer) throw new Error('Configura OPENAI_API_KEY para calcular los vectores')
      return indexer({ all })
    },
    async findProducts(text, sku) {
      if (sku?.trim()) {
        const { data, error } = await db.from('product_catalog').select(columns).eq('active', true).eq('sku', sku.trim()).limit(8)
        if (error) throw error
        return (data || []).map(product)
      }
      if (!tokens(text).length) return []
      const { docs, brands } = await searchProducts(text)
      const ranked = decideMatch(text, docs, brands).ranked.filter(c => !c.conflicts.length && c.coverage > 0).slice(0, 8)
      const products = new Map((await getProducts(ranked.map(c => c.doc.id))).map(p => [p.id, p]))
      return ranked.map(c => products.get(c.doc.id)).filter((p): p is Product => Boolean(p))
    },
    async getProduct(id) {
      if (!isUuid(id)) return null
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
    async customerExists(id) {
      if (!isUuid(id)) return false
      const { data, error } = await db.from('customers').select('id').eq('id', id).maybeSingle()
      if (error) throw error
      return Boolean(data)
    },
    async paymentMethods() {
      const { data, error } = await db.from('payment_method_catalog').select('code, label').eq('active', true).order('sort_order')
      if (error) throw error
      return data || []
    },
    async stockLevels(ids) {
      const { data, error } = await db.from('product_catalog').select('id, name, unit, stock_on_hand, min_stock').in('id', ids)
      if (error) throw error
      return (data || []).map((row: any) => ({ id: row.id, name: row.name, unit: row.unit, stock: Number(row.stock_on_hand), min_stock: Number(row.min_stock || 0) }))
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
