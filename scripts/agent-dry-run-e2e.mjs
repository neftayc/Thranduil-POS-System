// Dry-run end to end with mocks only (no database, no OpenAI): agent 1 (real draft builder + hybrid
// search over tests/fixtures/catalog-snapshot.json + prepareSale) → process 2 (real validator +
// orchestrator in dry-run). Only the interpreter (what the LLM would return) and create_sale are
// simulated; create_sale must never be called. Usage: node scripts/agent-dry-run-e2e.mjs
import { createRequire } from 'node:module'
import { realpathSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)))
const jiti = createRequire(realpathSync(join(repo, 'node_modules/nuxt/package.json')))('jiti').createJiti(repo + '/')
const load = path => jiti.import(join(repo, path))
const search = await load('server/modules/agent/app/productSearch.ts')
const { makeHybridDraftBuilder } = await load('server/modules/agent/app/draftBuilder.ts')
const { makeDraftValidator } = await load('server/modules/agent/app/validateDraft.ts')
const { makeSalesAgent } = await load('server/modules/agent/app/salesAgent.ts')
const { makeFileAgentStore } = await load('server/modules/agent/infra/fileAgentStore.ts')
const { makeConsolidatedRegistrar } = await load('server/modules/agent/app/registrar.ts')

const snapshot = JSON.parse(readFileSync(join(repo, 'tests/fixtures/catalog-snapshot.json'), 'utf8'))
const products = new Map(snapshot.map(d => [d.id, { id: d.id, name: d.name, sku: d.sku, brand: d.brand, unit: 'unidad', stock: 20, avg_cost: 3.2 }]))
const catalog = {
  searchProducts: async text => ({ docs: search.retrieveLexical(text, snapshot), brands: search.brandVocabulary(snapshot) }),
  getProducts: async ids => ids.map(id => products.get(id)).filter(Boolean),
  getProduct: async id => products.get(id) || null,
  findProducts: async () => [], findCustomers: async () => [], customerExists: async () => false,
  paymentMethods: async () => [{ code: 'efectivo', label: 'Efectivo' }, { code: 'yape', label: 'Yape' }],
  quote: async (p, qty, unit) => ({ unit_name: unit || p.unit, price: 4.5, factor: 1, currency: 'PEN' }),
  stockLevels: async ids => ids.map(id => ({ id, name: products.get(id).name, unit: 'unidad', stock: 20, min_stock: 2 }))
}
const MARKIN = 'cuaderno markin cuadriculado 100 a4'
const order = (quantity, price, payment = 'efectivo', query = MARKIN) => ({
  intent: 'sale', items: [{ query, sku: null, quantity, unit: null, price, product_id: null }], payment_method: payment, customer_query: null, question: null
})
// [name, seller text, interpreter output, seller role, expected outcome, check]
const cases = [
  ['sin cantidad', `vende ${MARKIN}, efectivo`, order(null, null), 'cashier', 'completed', r => r.result.items[0].qty === 1],
  ['cantidad dicha', 'vende tres cuadernos markin cuadriculados 100 a4, efectivo', order(3, null), 'cashier', 'completed', r => r.result.items[0].qty === 3],
  ['cantidad en palabras y la IA la pierde', 'dos cuadernos markin cuadriculados 100 a4, efectivo', order(null, null), 'cashier', 'completed', r => r.result.items[0].qty === 2],
  ['cantidad dentro de la descripción', 'dos cuadernos markin cuadriculados 100 a4, efectivo', order(null, null, 'efectivo', 'dos ' + MARKIN), 'cashier', 'completed', r => r.result.items[0].qty === 2],
  ['100 hojas (la IA propone 100)', 'vende cuaderno markin cuadriculado 100 hojas a4, efectivo', order(100, null), 'cashier', 'completed', r => r.result.items[0].qty === 1],
  ['precio dictado distinto, owner → por confirmar', 'vende 2 cuadernos markin cuadriculados 100 a4 a 4 soles, yape', order(2, 4, 'yape'), 'owner', 'pending_review', r => r.result.reasons.some(x => x.code === 'price_modified') && r.result.items[0].price_unit === 4 && r.result.items[0].list_price === 4.5 && r.result.reservations.length === 1],
  ['precio dictado distinto, cajero → por confirmar', 'vende 2 cuadernos markin cuadriculados 100 a4 a 4 soles, yape', order(2, 4, 'yape'), 'cashier', 'pending_review', r => r.result.reasons.some(x => x.code === 'price_modified')],
  ['precio dictado igual al de lista → directo', 'vende 2 cuadernos markin cuadriculados 100 a4 a 4.50 soles, yape', order(2, 4.5, 'yape'), 'cashier', 'completed', r => r.result.items[0].price_unit === 4.5],
  ['bajo costo, manager (ve el costo)', 'vende 2 cuadernos markin cuadriculados 100 a4 a 3 soles, efectivo', order(2, 3), 'manager', 'pending_review', r => r.result.price_alerts[0]?.unit_cost === 3.2],
  ['bajo costo, cajero (no ve el costo)', 'vende 2 cuadernos markin cuadriculados 100 a4 a 3 soles, efectivo', order(2, 3), 'cashier', 'pending_review', r => r.result.price_alerts[0] && r.result.price_alerts[0].unit_cost === undefined && !/3\.20/.test(r.message)],
  ['precio inventado por el modelo', 'vende 2 cuadernos markin cuadriculados 100 a4, efectivo', order(2, 4), 'owner', 'pending_review', r => r.result.reasons.some(x => x.code === 'price_unverified')],
  ['precio no dictado', 'vende 2 cuadernos markin cuadriculados 100 a4, efectivo', order(2, null), 'cashier', 'completed', r => r.result.items[0].price_unit === 4.5],
  ['«$4» del dictado es precio (4 soles) → por confirmar', 'vende 2 cuadernos markin cuadriculados 100 a4 a $4, efectivo', order(2, 4), 'cashier', 'pending_review', r => r.result.reasons.some(x => x.code === 'price_modified') && r.result.items[0].qty === 2]
]
let ok = 0, fail = 0, sales = 0
for (const [name, text, interpretation, role, expected, check] of cases) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-dry-run-e2e-'))
  try {
    const agent = makeSalesAgent({
      store: makeFileAgentStore(dir),
      buildDraft: makeHybridDraftBuilder(async () => interpretation, catalog, { answerCatalogQuestions: true }),
      validate: makeDraftValidator(catalog),
      execute: async () => { sales++; throw new Error('create_sale NO debe llamarse') },
      stockLevels: catalog.stockLevels, dryRun: true
    })
    const r = await agent({ protocol: 'yachay-agent/1', type: 'instruction', request_id: randomUUID(), input: { text } }, { id: 'u-' + role, role })
    const got = r.result?.would_be || r.status
    const pass = got === expected && r.result?.dry_run === true && Boolean(check(r))
    pass ? ok++ : fail++
    const items = (r.result?.items || []).map(i => `${i.qty} × S/ ${i.price_unit}${i.list_price ? ` (lista ${i.list_price})` : ''}`).join('; ')
    const codes = (r.result?.reasons || []).map(x => x.code).join(',')
    console.log(`${pass ? 'OK  ' : 'FAIL'} | ${name} | esperado ${expected} | obtenido ${got} | ${items}${codes ? ' | ' + codes : ''}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---- Paso 3 (POS_AGENT_SELECTOR=llm): consolidado del selector → registrador simplificado
console.log('\n--- paso 3: registrador con consolidado (sale-consolidated/1)')
const markin = snapshot.find(p => p.name === 'Cuaderno Markin # 100 h')
const other = snapshot.find(p => p.id !== markin.id && /cuaderno/i.test(p.name))
const cons = (lines, extra = {}) => ({ contract: 'sale-consolidated/1', lines, payment_method: 'efectivo', payment_phrase: null, questions: [], ...extra })
const cl = (phrase, o = {}) => ({ phrase, product_id: markin.id, quantity: 2, unit: null, price_said: null, confidence: 'alta', reason: 'Markin # 100 h', question: null, options: [], ...o })
const step3 = [
  ['consolidado válido', 'dos cuadernos markin cuadriculados de 100 hojas, yape', cons([cl('dos cuadernos markin')], { payment_method: 'yape', payment_phrase: 'yape' }), 'completed', r => r.result.items[0].qty === 2 && r.result.payment_method === 'yape'],
  ['sin pago → efectivo', 'dos cuadernos markin', cons([cl('dos cuadernos markin')]), 'completed', r => r.result.payment_defaulted === true],
  ['confianza baja → pregunta con opciones', 'dos cuadernos de 100 hojas', cons([cl('dos cuadernos', { confidence: 'baja', question: '¿Markin u otro?', options: [markin.id, other.id] })]), 'pending_review', r => r.result.reasons[0].options.length === 2],
  ['frase no literal (autocorrección de voz) → directo', 'dos cuadernos, ...perdón, dos cuadernos markin', cons([cl('2 cuadernos Markin')]), 'completed', r => r.result.items[0].qty === 2],
  ['precio dictado → por confirmar', 'dos cuadernos markin a 4 soles', cons([cl('dos cuadernos markin a 4 soles', { price_said: 4 })]), 'pending_review', r => r.result.reasons[0].code === 'price_modified'],
  ['yape no dicho → revisión', 'dos cuadernos markin', cons([cl('dos cuadernos markin')], { payment_method: 'yape' }), 'pending_review', r => r.result.reasons[0].code === 'missing_payment'],
  ['id inexistente → revisión', 'dos cuadernos markin', cons([cl('dos cuadernos markin', { product_id: randomUUID() })]), 'pending_review', r => r.result.reasons[0].code === 'product_inactive']
]
for (const [name, text, consolidated, expected, check] of step3) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-dry-run-e2e-'))
  try {
    const agent = makeSalesAgent({
      store: makeFileAgentStore(dir), buildDraft: async () => consolidated,
      validate: makeDraftValidator(catalog), registrar: makeConsolidatedRegistrar(catalog),
      execute: async () => { sales++; throw new Error('create_sale NO debe llamarse') },
      stockLevels: catalog.stockLevels, dryRun: true
    })
    const r = await agent({ protocol: 'yachay-agent/1', type: 'instruction', request_id: randomUUID(), input: { text } }, { id: 'u-cashier', role: 'cashier' })
    const got = r.result?.would_be || r.status
    const pass = got === expected && r.result?.dry_run === true && Boolean(check(r))
    pass ? ok++ : fail++
    console.log(`${pass ? 'OK  ' : 'FAIL'} | ${name} | esperado ${expected} | obtenido ${got} | ${(r.result?.reasons || []).map(x => x.code).join(',')}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
console.log(`\n${ok} OK, ${fail} fallas; llamadas a create_sale: ${sales}`)
process.exit(fail || sales ? 1 : 0)
