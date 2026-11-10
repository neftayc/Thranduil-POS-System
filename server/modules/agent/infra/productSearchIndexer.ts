import type { SupabaseClient } from '@supabase/supabase-js'
import type { Embedder } from './openaiEmbeddings'

export type IndexResult = { embedded: number; skipped: number }

/**
 * Computes the vectors that are missing or stale in product_search_index (new/edited product,
 * new synonym or a different embedding model). The text itself is kept up to date by triggers.
 */
export const makeProductSearchIndexer = (db: SupabaseClient, embed: Embedder, model: string) => {
  const run = async ({ all = false, limit = 1000 }: { all?: boolean; limit?: number } = {}): Promise<IndexResult> => {
    const result: IndexResult = { embedded: 0, skipped: 0 }
    const seen = new Set<string>()
    while (result.embedded + result.skipped < limit) {
      const { data, error } = await db.rpc('product_search_pending', { p_model: model, p_limit: all ? 1000 : Math.min(200, limit), p_all: all })
      if (error) throw error
      const rows = ((data || []) as Array<{ product_id: string; document: string; content_hash: string }>).filter(row => !seen.has(row.product_id))
      if (!rows.length) break
      rows.forEach(row => seen.add(row.product_id))
      const vectors = await embed(rows.map(row => row.document))
      const embeddedAt = new Date().toISOString()
      for (const [index, row] of rows.entries()) {
        // Guard on content_hash: if the product changed meanwhile, the newer text wins and stays pending.
        const { data: updated, error: updateError } = await db.from('product_search_index')
          .update({ embedding: JSON.stringify(vectors[index]), embedding_model: model, embedded_hash: row.content_hash, embedded_at: embeddedAt })
          .eq('product_id', row.product_id).eq('content_hash', row.content_hash).select('product_id')
        if (updateError) throw updateError
        if (updated?.length) result.embedded++
        else result.skipped++
      }
    }
    return result
  }
  return run
}
