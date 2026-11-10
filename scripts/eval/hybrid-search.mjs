// Measures the hybrid matcher over the test orders and the catalog snapshot (offline, read-only).
// Usage: node scripts/eval/hybrid-search.mjs [--vectors]  (--vectors computes embeddings in memory with OpenAI)
import fs from 'node:fs'
import { createRequire } from 'node:module'
import dotenv from 'dotenv'
dotenv.config({ quiet: true })
const requireNuxt = createRequire(import.meta.resolve('nuxt/package.json'))
const jiti = requireNuxt('jiti').createJiti(import.meta.url)
const search = await jiti.import('../../server/modules/agent/app/productSearch.ts')
const catalog = JSON.parse(fs.readFileSync(new URL('../../tests/fixtures/catalog-snapshot.json', import.meta.url)))
const file = process.argv.find(a => a.endsWith('.json')) || 'tests/fixtures/agent-search-cases.json'
const cases = JSON.parse(fs.readFileSync(new URL('../../' + file, import.meta.url)))
const verbose = process.argv.includes('-v')
let vectorSearch = null
if (process.argv.includes('--vectors')) {
  const { makeOpenAIEmbedder, productDocument } = await jiti.import('../../server/modules/agent/infra/openaiEmbeddings.ts')
  const embed = makeOpenAIEmbedder(process.env.OPENAI_API_KEY, process.env.POS_AGENT_EMBEDDING_MODEL)
  const vectors = await embed(catalog.map(d => productDocument({ ...d, category: d.category })))
  const cos = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s }
  vectorSearch = async text => {
    const [q] = await embed([text])
    return catalog.map((d, i) => ({ ...d, vector_similarity: cos(q, vectors[i]) })).sort((a, b) => b.vector_similarity - a.vector_similarity).slice(0, 40).map((d, i) => ({ ...d, vector_rank: i + 1 }))
  }
}
const brands = search.brandVocabulary(catalog)
const stats = { high_correct: 0, high_wrong: 0, medium_with_correct_preselected: 0, correct_in_top5: 0, negatives_safe: 0 }
const positives = cases.filter(c => c.expect === 'high'), negatives = cases.filter(c => c.expect !== 'high')
for (const c of cases) {
  const text = c.text.replace(/^vender\s+/i, '')
  const lexical = search.retrieveLexical(text, catalog)
  const pool = vectorSearch ? search.fuseRanks(lexical, await vectorSearch(text)) : lexical
  const d = search.decideMatch(text, pool, brands)
  const ok = d.best && c.expected.includes(d.best.doc.id)
  if (c.expect === 'high') {
    if (d.confidence === 'high' && ok) stats.high_correct++
    if (d.confidence === 'medium' && ok) stats.medium_with_correct_preselected++
    if (d.ranked.slice(0, 5).some(r => c.expected.includes(r.doc.id))) stats.correct_in_top5++
  } else if (d.confidence !== 'high') stats.negatives_safe++
  if (d.confidence === 'high' && !ok) stats.high_wrong++
  const mark = c.expect === 'high' ? (d.confidence === 'high' && ok ? '✔' : ok ? '~' : '✘') : (d.confidence !== 'high' ? '✔' : '✘')
  console.log(`${mark} ${d.confidence.padEnd(6)} | ${c.text} → ${d.best ? d.best.doc.name + (d.best.doc.brand ? ' / ' + d.best.doc.brand : '') : '—'}${verbose ? '\n     ' + d.ranked.slice(0, 3).map(r => `${r.doc.name} [cov ${r.coverage.toFixed(2)} m:${r.matched} u:${r.unknown} c:${r.conflicts} x${r.extra}]`).join('\n     ') + '\n     dudas: ' + d.doubts.join(' ') : ''}`)
}
console.log(JSON.stringify({ casos: cases.length, positivos: positives.length, negativos: negatives.length, vectores: Boolean(vectorSearch), ...stats }))
