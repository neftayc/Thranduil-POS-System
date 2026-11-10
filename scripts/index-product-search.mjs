// (Re)computes the product vectors of product_search_index (hybrid search of the sales agent).
// The text of the index is maintained by database triggers; this script only fills the vectors
// that are missing or stale (new/edited product, new synonym, different model).
//
//   node scripts/index-product-search.mjs          # only pending vectors
//   node scripts/index-product-search.mjs --all    # recompute every vector (e.g. after changing the model)
//
// Needs SUPABASE_URL (or NUXT_PUBLIC_SUPABASE_URL), SUPABASE_SERVICE_ROLE, OPENAI_API_KEY and,
// optionally, POS_AGENT_EMBEDDING_MODEL. Secrets are never printed.
import dotenv from 'dotenv'
import { createRequire } from 'node:module'
import { createClient } from '@supabase/supabase-js'

dotenv.config({ quiet: true })
const requireNuxt = createRequire(import.meta.resolve('nuxt/package.json'))
const jiti = requireNuxt('jiti').createJiti(import.meta.url)
const { makeOpenAIEmbedder, embeddingModelName } = await jiti.import('../server/modules/agent/infra/openaiEmbeddings.ts')
const { makeProductSearchIndexer } = await jiti.import('../server/modules/agent/infra/productSearchIndexer.ts')

const url = process.env.SUPABASE_URL || process.env.NUXT_PUBLIC_SUPABASE_URL
const serviceRole = process.env.SUPABASE_SERVICE_ROLE
const openaiKey = process.env.OPENAI_API_KEY
for (const [name, value] of [['SUPABASE_URL', url], ['SUPABASE_SERVICE_ROLE', serviceRole], ['OPENAI_API_KEY', openaiKey]]) {
  if (!value) { console.error(`Falta ${name} en .env`); process.exit(1) }
}
const model = embeddingModelName(process.env.POS_AGENT_EMBEDDING_MODEL)
const db = createClient(url, serviceRole, { auth: { persistSession: false } })
const index = makeProductSearchIndexer(db, makeOpenAIEmbedder(openaiKey, model), model)
const all = process.argv.includes('--all')
const started = Date.now()
try {
  const result = await index({ all, limit: 100000 })
  const { count } = await db.from('product_search_index').select('product_id', { count: 'exact', head: true })
  console.log(`Modelo ${model}: ${result.embedded} vectores calculados, ${result.skipped} omitidos por cambios concurrentes; ${count ?? '?'} productos en el índice (${((Date.now() - started) / 1000).toFixed(1)} s).`)
} catch (error) {
  const missing = ['PGRST202', '42883', '42P01'].includes(String(error?.code || ''))
  console.error(missing
    ? 'La migración 20261110_product_hybrid_search.sql no está aplicada en esta base de datos.'
    : `No se pudo indexar: ${error?.message || error}`)
  process.exit(1)
}
