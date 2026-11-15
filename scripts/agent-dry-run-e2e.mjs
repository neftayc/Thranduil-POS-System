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
  ['precio dictado, owner', 'vende 2 cuadernos markin cuadriculados 100 a4 a 4 soles, yape', order(2, 4, 'yape'), 'owner', 'completed', r => r.result.items[0].price_unit === 4 && r.result.items[0].list_price === 4.5],
  ['precio dictado, cajero', 'vende 2 cuadernos markin cuadriculados 100 a4 a 4 soles, yape', order(2, 4, 'yape'), 'cashier', 'completed', r => r.result.items[0].price_unit === 4],
  ['bajo costo, manager (ve el costo)', 'vende 2 cuadernos markin cuadriculados 100 a4 a 3 soles, efectivo', order(2, 3), 'manager', 'completed', r => r.result.price_alerts[0]?.unit_cost === 3.2],
  ['bajo costo, cajero (no ve el costo)', 'vende 2 cuadernos markin cuadriculados 100 a4 a 3 soles, efectivo', order(2, 3), 'cashier', 'completed', r => r.result.price_alerts[0] && r.result.price_alerts[0].unit_cost === undefined && !/3\.20/.test(r.message)],
  ['precio inventado por el modelo', 'vende 2 cuadernos markin cuadriculados 100 a4, efectivo', order(2, 4), 'owner', 'pending_review', r => r.result.reasons.some(x => x.code === 'price_unverified')],
  ['precio no dictado', 'vende 2 cuadernos markin cuadriculados 100 a4, efectivo', order(2, null), 'cashier', 'completed', r => r.result.items[0].price_unit === 4.5],
  ['«$1» del dictado es un sol', 'vende 2 cuadernos markin cuadriculados 100 a4 a $4, efectivo', order(2, 4), 'cashier', 'completed', r => r.result.items[0].price_unit === 4]
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
console.log(`\n${ok} OK, ${fail} fallas; llamadas a create_sale: ${sales}`)
process.exit(fail || sales ? 1 : 0)
