import OpenAI from 'openai'

/** Vector size of product_search_index.embedding (the column is vector(1536)). */
export const EMBEDDING_DIMENSIONS = 1536
export const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small'

export type Embedder = (texts: string[]) => Promise<number[][]>

/**
 * Text that represents a product in the vector index. It deliberately excludes price and
 * stock: those change every day and are always read live.
 */
export const productDocument = (doc: { name: string; brand?: string | null; category?: string | null; synonyms?: string[] | null }) => [
  doc.name.trim(),
  doc.brand?.trim() ? `Marca: ${doc.brand.trim().replace(/,+$/, '')}` : '',
  doc.category?.trim() ? `Categoría: ${doc.category.trim()}` : '',
  doc.synonyms?.length ? `También: ${doc.synonyms.join('; ')}` : ''
].filter(Boolean).join('. ')

/** OpenAI embeddings; the model is configurable (POS_AGENT_EMBEDDING_MODEL) and always returns 1536 dimensions. */
export const makeOpenAIEmbedder = (apiKey: string, model?: string | null, timeoutMs = 60000): Embedder => {
  const client = new OpenAI({ apiKey, timeout: timeoutMs, maxRetries: 1 })
  const name = String(model || '').trim() || DEFAULT_EMBEDDING_MODEL
  return async (texts) => {
    const out: number[][] = []
    for (let i = 0; i < texts.length; i += 256) {
      const batch = texts.slice(i, i + 256)
      const response = await client.embeddings.create({
        model: name,
        input: batch,
        // text-embedding-ada-002 does not accept `dimensions`.
        ...(name.startsWith('text-embedding-3') ? { dimensions: EMBEDDING_DIMENSIONS } : {})
      })
      for (const item of response.data.sort((a, b) => a.index - b.index)) {
        if (item.embedding.length !== EMBEDDING_DIMENSIONS) throw new Error(`El modelo de embeddings devolvió ${item.embedding.length} dimensiones; se esperaban ${EMBEDDING_DIMENSIONS}`)
        out.push(item.embedding)
      }
    }
    return out
  }
}

export const embeddingModelName = (model?: string | null) => String(model || '').trim() || DEFAULT_EMBEDDING_MODEL
