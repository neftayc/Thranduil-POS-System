// Benchmark of the sales selector (step 2): legacy (current chain) vs the LLM selector with the
// whole catalog in context, over the real dictations (tests/fixtures/golden-dictados.json) and a
// READ-ONLY snapshot of the real catalog (tests/fixtures/selector-catalog.json).
//
//   node scripts/selector-benchmark.mjs                                   # legacy + gpt-5.4 + gpt-5.4-mini
//   node scripts/selector-benchmark.mjs --models gpt-5.4-mini --no-legacy --cases D8,D8b -v
//
// Calls the OpenAI API (OPENAI_API_KEY from .env). Never touches the database.
import fs from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'
import { createRequire } from 'node:module'

dotenv.config({ quiet: true })
const jiti = createRequire(import.meta.resolve('nuxt/package.json'))('jiti').createJiti(import.meta.url)
const { makeSalesSelector } = await jiti.import('../server/modules/agent/app/salesSelector.ts')
const { makeOpenAISelectorModel } = await jiti.import('../server/modules/agent/infra/openaiSalesSelector.ts')
const { makeHybridDraftBuilder } = await jiti.import('../server/modules/agent/app/draftBuilder.ts')
const { makeOpenAIOrderInterpreter } = await jiti.import('../server/modules/agent/infra/openaiOrderInterpreter.ts')
const { makeOpenAIProductSelector } = await jiti.import('../server/modules/agent/infra/openaiProductSelector.ts')
const search = await jiti.import('../server/modules/agent/app/productSearch.ts')

const arg = (name, fallback = null) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback }
const verbose = process.argv.includes('-v')
const key = process.env.OPENAI_API_KEY
if (!key) { console.error('Falta OPENAI_API_KEY en .env'); process.exit(1) }

// List prices per 1M tokens (USD) from developers.openai.com, Nov 2026 — verify before budgeting.
const PRICES = {
  'gpt-5.4': { input: 2.5, cached: 0.25, output: 15 },
  'gpt-5.4-mini': { input: 0.75, cached: 0.075, output: 4.5 },
  'gpt-4.1-mini': { input: 0.4, cached: 0.1, output: 1.6 },
  'gpt-4o-mini': { input: 0.15, cached: 0.075, output: 0.6 }
}
const models = (arg('models', 'gpt-5.4,gpt-5.4-mini')).split(',').map(s => s.trim()).filter(Boolean)
const legacyModel = arg('legacy-model', process.env.POS_AGENT_MODEL || 'gpt-4o-mini')
const runLegacy = !process.argv.includes('--no-legacy')

const root = new URL('..', import.meta.url)
const catalog = JSON.parse(fs.readFileSync(new URL('tests/fixtures/selector-catalog.json', root)))
const golden = JSON.parse(fs.readFileSync(new URL('tests/fixtures/golden-dictados.json', root)))
const only = arg('cases') ? new Set(arg('cases').split(',')) : null
const cases = golden.cases.filter(c => !only || only.has(c.id) || golden.cases.some(d => d.follows === c.id && only.has(d.id)))

// Names → ids (a name may match several products: any of them is accepted unless a brand is given).
const idsOf = (name, brand) => catalog.products.filter(p => p.name === name && (!brand || p.brand === brand)).map(p => p.id)
const nameOf = id => catalog.products.find(p => p.id === id)?.name ?? (id ? `?${id.slice(0, 8)}` : '—')

// ------------------------------------------------------------------ systems

const llmSystem = model => {
  const select = makeSalesSelector({ model: makeOpenAISelectorModel(key, model), catalog: async () => catalog })
  return async (messages, previous) => {
    const { consolidated, usage } = await select({ messages, previous })
    const price = PRICES[model]
    const cost = price ? ((usage.input_tokens - usage.cached_tokens) * price.input + usage.cached_tokens * price.cached + usage.output_tokens * price.output) / 1e6 : null
    return { state: consolidated, lines: consolidated.lines, usage: { ...usage, cost } }
  }
}

// The current chain (interpreter → hybrid search + rules → context selector), on the same snapshot.
const legacySystem = () => {
  const products = new Map(catalog.products.map(p => [p.id, { id: p.id, name: p.name, sku: null, brand: p.brand, unit: p.unit, stock: p.stock }]))
  const docs = catalog.products.map(p => ({ id: p.id, name: p.name, brand: p.brand, category: p.type, sku: null }))
  const brands = search.brandVocabulary(docs)
  const agentCatalog = {
    searchProducts: async text => ({ docs: search.retrieveLexical(text, docs), brands }),
    getProducts: async ids => ids.map(id => products.get(id)).filter(Boolean),
    getProduct: async id => products.get(id) || null,
    findProducts: async () => [],
    findCustomers: async () => [],
    customerExists: async () => false,
    paymentMethods: async () => catalog.payment_methods,
    quote: async (p, qty, unit) => {
      const row = catalog.products.find(x => x.id === p.id)
      const pres = row.presentations.find(x => x.unit === (unit || row.unit)) || row.presentations[0]
      if (pres.price === null) throw new Error('sin precio')
      return { unit_name: pres.unit, price: pres.price, factor: pres.factor, currency: 'PEN' }
    }
  }
  const build = makeHybridDraftBuilder(makeOpenAIOrderInterpreter(key, legacyModel), agentCatalog, { selector: makeOpenAIProductSelector(key, legacyModel) })
  return async (messages, previous) => {
    const started = Date.now()
    const draft = await build(messages, previous)
    const items = Array.isArray(draft?.items) ? draft.items : []
    const lines = items.map(item => ({
      phrase: item.query, product_id: item.product_id, quantity: item.quantity ?? 1,
      confidence: item.confidence === 'high' ? 'alta' : 'baja',
      options: item.confidence === 'high' ? [] : [item.product_id, ...item.candidates].filter(Boolean),
      question: item.confidence === 'high' ? null : item.doubts.map(d => d.note).join(' ').slice(0, 200)
    }))
    return { state: Array.isArray(draft?.items) ? draft : null, lines, usage: { latency_ms: Date.now() - started, cost: null, input_tokens: null, cached_tokens: null, output_tokens: null } }
  }
}

// ------------------------------------------------------------------ scoring

const expectedIds = line => line.product ? idsOf(line.product, line.brand) : []
const optionIds = line => (line.options || []).flatMap(n => idsOf(n))
const alsoIds = line => line.also_ok ? idsOf(line.also_ok.product) : []
const asks = l => l.confidence !== 'alta' || !l.product_id

/** Pairs expected and returned lines (same product, then an ask that offers an expected option, then order). */
const pair = (expected, got) => {
  const free = new Set(got.map((_, i) => i))
  const pairs = expected.map(() => null)
  const take = (i, j) => { pairs[i] = j; free.delete(j) }
  // 1) same product decided with «alta»; 2) same product; 3) a question offering an expected product/option; 4) order.
  for (const highOnly of [true, false]) expected.forEach((e, i) => {
    if (pairs[i] !== null) return
    const ids = [...expectedIds(e), ...alsoIds(e)]
    const j = [...free].find(k => got[k].product_id && ids.includes(got[k].product_id) && (!highOnly || !asks(got[k])))
    if (j !== undefined) take(i, j)
  })
  expected.forEach((e, i) => {
    if (pairs[i] !== null) return
    const ids = [...optionIds(e), ...expectedIds(e)]
    const j = [...free].find(k => [got[k].product_id, ...(got[k].options || [])].some(id => id && ids.includes(id)))
    if (j !== undefined) take(i, j)
  })
  expected.forEach((e, i) => { if (pairs[i] === null && free.size) take(i, [...free][0]) })
  return { pairs, extra: [...free] }
}

const judge = (e, g) => {
  if (!g) return 'falta'
  const decided = !asks(g)
  if (!e.ask) {
    if (!decided) return [g.product_id, ...(g.options || [])].some(id => expectedIds(e).includes(id)) ? 'pregunta_de_mas' : 'pregunta_sin_opcion_correcta'
    if (!expectedIds(e).includes(g.product_id)) return 'equivocado_alta'
    return Number(g.quantity) === Number(e.quantity) ? 'correcto' : 'cantidad_errada'
  }
  if (decided) {
    if (e.also_ok && alsoIds(e).includes(g.product_id)) return Number(g.quantity) === Number(e.also_ok.quantity) ? 'correcto' : 'cantidad_errada'
    return 'equivocado_alta'
  }
  const offered = [g.product_id, ...(g.options || [])].filter(Boolean)
  return !optionIds(e).length || offered.some(id => optionIds(e).includes(id)) ? 'correcto' : 'pregunta_sin_opcion_correcta'
}

// ------------------------------------------------------------------ run

const systems = [...(runLegacy ? [[`legacy (${legacyModel})`, legacySystem()]] : []), ...models.map(m => [`llm ${m}`, llmSystem(m)])]
const report = []
for (const [label, run] of systems) {
  const states = new Map()
  const rows = []
  for (const c of cases) {
    const prior = c.follows ? cases.find(d => d.id === c.follows) : null
    const messages = [...(prior ? prior.messages : []), ...c.messages]
    const previous = prior ? states.get(prior.id) ?? null : null
    let result
    try { result = await run(messages, previous) } catch (error) { result = { state: null, lines: [], usage: { latency_ms: null, cost: null }, error: String(error?.message || error) } }
    states.set(c.id, result.state)
    const { pairs, extra } = pair(c.lines, result.lines)
    const verdicts = c.lines.map((e, i) => judge(e, pairs[i] === null ? null : result.lines[pairs[i]]))
    const extraHigh = extra.filter(j => !asks(result.lines[j])).length
    rows.push({ id: c.id, verdicts, extra: extra.length, extraHigh, usage: result.usage, error: result.error, lines: result.lines })
    const mark = verdicts.every(v => v === 'correcto') && !extra.length ? '✔' : verdicts.some(v => v === 'equivocado_alta' || v === 'cantidad_errada') || extraHigh ? '✘' : '~'
    console.log(`${label.padEnd(22)} ${mark} ${c.id.padEnd(4)} ${verdicts.join(', ')}${extra.length ? ` +${extra.length} extra` : ''}${result.error ? ` ERROR ${result.error}` : ''}${result.usage.latency_ms ? ` (${(result.usage.latency_ms / 1000).toFixed(1)} s)` : ''}`)
    if (verbose) for (const l of result.lines) console.log(`      ${l.confidence.padEnd(4)} ${String(l.quantity).padStart(3)} × ${nameOf(l.product_id)}  «${l.phrase}»${asks(l) ? `  ❓ ${(l.options || []).map(nameOf).join(' / ')}` : ''}`)
  }
  const all = rows.flatMap(r => r.verdicts)
  const count = v => all.filter(x => x === v).length
  const lat = rows.map(r => r.usage.latency_ms).filter(Number.isFinite).sort((a, b) => a - b)
  const costs = rows.map(r => r.usage.cost).filter(Number.isFinite)
  const tok = k => rows.map(r => r.usage[k]).filter(Number.isFinite)
  const sales = rows.filter(r => !cases.find(c => c.id === r.id).follows)
  report.push({
    sistema: label,
    lineas_correctas: `${count('correcto')}/${all.length}`,
    ventas_perfectas: `${rows.filter(r => r.verdicts.every(v => v === 'correcto') && !r.extra).length}/${rows.length}`,
    equivocados_alta: count('equivocado_alta') + rows.reduce((n, r) => n + r.extraHigh, 0),
    cantidad_errada: count('cantidad_errada'),
    preguntas_de_mas: count('pregunta_de_mas'),
    preguntas: rows.reduce((n, r) => n + r.lines.filter(asks).length, 0),
    preguntas_esperadas: cases.reduce((n, c) => n + c.lines.filter(l => l.ask).length, 0),
    faltan: count('falta'),
    lineas_extra: rows.reduce((n, r) => n + r.extra, 0),
    errores: rows.filter(r => r.error).length,
    latencia_mediana_s: lat.length ? +(lat[Math.floor(lat.length / 2)] / 1000).toFixed(1) : null,
    latencia_max_s: lat.length ? +(lat[lat.length - 1] / 1000).toFixed(1) : null,
    costo_medio_usd: costs.length ? +(costs.reduce((a, b) => a + b, 0) / costs.length).toFixed(5) : null,
    tokens_entrada_medio: tok('input_tokens').length ? Math.round(tok('input_tokens').reduce((a, b) => a + b, 0) / tok('input_tokens').length) : null,
    tokens_cache_medio: tok('cached_tokens').length ? Math.round(tok('cached_tokens').reduce((a, b) => a + b, 0) / tok('cached_tokens').length) : null,
    tokens_salida_medio: tok('output_tokens').length ? Math.round(tok('output_tokens').reduce((a, b) => a + b, 0) / tok('output_tokens').length) : null,
    ventas: sales.length,
    rows
  })
}

console.log('\n| Sistema | Líneas correctas | Ventas perfectas | Equivocados con alta | Cantidad errada | Preguntas (esperadas) | Preguntas de más | Faltan / extra | Latencia mediana (máx) | Costo medio por llamada | Tokens entrada (caché) / salida |')
console.log('|---|---|---|---|---|---|---|---|---|---|---|')
for (const r of report) {
  console.log(`| ${r.sistema} | ${r.lineas_correctas} | ${r.ventas_perfectas} | ${r.equivocados_alta} | ${r.cantidad_errada} | ${r.preguntas} (${r.preguntas_esperadas}) | ${r.preguntas_de_mas} | ${r.faltan} / ${r.lineas_extra} | ${r.latencia_mediana_s ?? '—'} s (${r.latencia_max_s ?? '—'} s) | ${r.costo_medio_usd === null ? 'n/d' : `US$ ${r.costo_medio_usd}`} | ${r.tokens_entrada_medio ?? '—'} (${r.tokens_cache_medio ?? '—'}) / ${r.tokens_salida_medio ?? '—'} |`)
}
const outDir = new URL('.data/selector-benchmark/', root)
fs.mkdirSync(outDir, { recursive: true })
const file = path.join(outDir.pathname, `benchmark-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
fs.writeFileSync(file, JSON.stringify({ catalog_taken_at: catalog.taken_at, models, legacyModel, report }, null, 1))
console.log(`\nDetalle: ${path.relative(process.cwd(), file)}`)
