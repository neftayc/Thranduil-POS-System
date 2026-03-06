// POST /api/utiles/embed-catalog
// Run this once to generate and store embeddings for all products.
// Re-run whenever products are added or updated significantly.

import { requireAccessToken } from '../../utils/auth'
import { getSupabaseAdminClient } from '../../utils/supabase'
import { getOpenAIClient } from '../../utils/openai'

const BATCH_SIZE = 50 // OpenAI allows up to 2048 inputs per request

export default defineEventHandler(async (event) => {
  await requireAccessToken(event)

  const supabase = getSupabaseAdminClient()
  const openai = getOpenAIClient()

  // 1. Fetch all active products
  const { data: products, error } = await supabase
    .from('products')
    .select('id, name, sku, unit')
    .eq('active', true)

  if (error) throw createError({ statusCode: 500, statusMessage: error.message })
  if (!products?.length) return { embedded: 0, message: 'No hay productos activos' }

  // 2. Build text to embed per product (name + unit for richer context)
  const texts = products.map(p =>
    [p.name, p.unit ? `unidad: ${p.unit}` : '', p.sku ? `sku: ${p.sku}` : '']
      .filter(Boolean).join(' | ')
  )

  // 3. Embed in batches
  let totalTokens = 0
  const embeddings: number[][] = []

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE)
    const res = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: batch
    })
    res.data.forEach(d => embeddings.push(d.embedding))
    totalTokens += res.usage?.total_tokens ?? 0
  }

  // 4. Upsert embeddings into Supabase
  const updates = products.map((p, i) => ({
    id: p.id,
    embedding: JSON.stringify(embeddings[i]) // pgvector accepts JSON array string
  }))

  const { error: upsertError } = await supabase
    .from('products')
    .upsert(updates, { onConflict: 'id' })

  if (upsertError) throw createError({ statusCode: 500, statusMessage: upsertError.message })

  return {
    embedded: products.length,
    total_tokens_used: totalTokens,
    estimated_cost_usd: +((totalTokens * 0.00000002).toFixed(6)), // $0.02/M tokens
    message: `✅ ${products.length} productos embeddeados correctamente`
  }
})
