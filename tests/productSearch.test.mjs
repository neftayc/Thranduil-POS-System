import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

// Agent 1: hybrid product matching, proposal contract and catalog answers (offline, no DB/OpenAI).
const requireNuxt = createRequire(import.meta.resolve('nuxt/package.json'))
const jiti = requireNuxt('jiti').createJiti(import.meta.url)
const search = await jiti.import('../server/modules/agent/app/productSearch.ts')
const { makeSalePreparer } = await jiti.import('../server/modules/agent/app/prepareSale.ts')
const { makeCatalogAnswerer } = await jiti.import('../server/modules/agent/app/catalogAnswers.ts')
const { productDocument } = await jiti.import('../server/modules/agent/infra/openaiEmbeddings.ts')

const snapshot = JSON.parse(readFileSync(new URL('./fixtures/catalog-snapshot.json', import.meta.url)))
const brands = search.brandVocabulary(snapshot)
const byName = name => snapshot.find(p => p.name === name)
const decide = text => search.decideMatch(text, search.retrieveLexical(text, snapshot), brands)

// Snapshot-backed catalog with live-like stock/price (the real ones come from Supabase).
const catalogFrom = (docs, overrides = {}) => {
  const products = new Map(docs.map(d => [d.id, { id: d.id, name: d.name, sku: d.sku, brand: d.brand, unit: 'unidad', stock: 20 }]))
  return {
    searchProducts: async text => ({ docs: search.retrieveLexical(text, docs), brands: search.brandVocabulary(docs) }),
    getProducts: async ids => ids.map(id => products.get(id)).filter(Boolean),
    getProduct: async id => products.get(id) || null,
    findProducts: async (_q, sku) => [...products.values()].filter(p => p.sku === sku),
    findCustomers: async () => [],
    paymentMethods: async () => [{ code: 'efectivo', label: 'Efectivo' }, { code: 'yape', label: 'Yape' }],
    quote: async (p, qty, unit) => ({ unit_name: unit || p.unit, price: 4.5, factor: 1, currency: 'PEN' }),
    ...overrides
  }
}
const sale = (query, quantity = 2, extra = {}) => ({
  intent: 'sale', items: [{ query, sku: null, quantity, unit: null, product_id: null, ...extra }],
  payment_method: 'efectivo', customer_query: null, question: null
})

test('caso Markin: «cuaderno markin cuadriculado 100 a4» encuentra el producto con seguridad alta', () => {
  const d = decide('cuaderno markin cuadriculado 100 a4')
  assert.equal(d.confidence, 'high')
  assert.equal(d.best.doc.name, 'Cuaderno Markin # 100 h')
  const reasons = search.reasonsFor(d.best)
  assert.ok(reasons.includes('cuadriculado coincide'))
  assert.ok(reasons.includes('100 coincide'))
  assert.ok(reasons.some(r => /A4 no confirmado/.test(r)), 'avisa que el nombre no dice A4')
})

test('los números y medidas exactas pesan: 50 hojas no es 100 hojas', () => {
  const d = decide('cuaderno markin cuadriculado 50 hojas')
  assert.equal(d.confidence, 'low')
  assert.equal(d.best, null)
  const markin = d.ranked.find(c => c.doc.name === 'Cuaderno Markin # 100 h')
  assert.ok(markin.conflicts.some(c => /50/.test(c)))
})

test('rayado, triple renglón y cuadriculado (#) no se confunden', () => {
  assert.equal(decide('cuaderno markin triple renglon').best.doc.name, 'cuaderno markin triple reglon 100 h')
  assert.equal(decide('cuaderno surco rayado 100 hojas').best.doc.name, 'cuaderno surco rayado 100 h')
  const teens = decide('cuaderno layconsa teens rayado')
  assert.notEqual(teens.confidence, 'high')
})

test('A4/grande y A5/pequeño se tratan como tamaños compatibles o en conflicto', () => {
  assert.equal(decide('cuaderno anillado a4').best.doc.name, 'Cuaderno Anillado A4 100h')
  const small = decide('cuaderno surco pequeño 100h')
  assert.equal(small.confidence, 'high')
  assert.equal(small.best.doc.name, 'cuaderno surco pqueño 100 h')
})

test('la marca pedida descarta otras marcas', () => {
  const d = decide('goma en barra faber castell 40 gramos')
  assert.equal(d.confidence, 'high')
  assert.equal(d.best.doc.brand, 'Faber Castell')
  assert.ok(d.ranked.find(c => c.doc.brand === 'Artesco').conflicts.length > 0)
})

test('empates reales quedan por confirmar (nunca elige al azar)', () => {
  for (const text of ['caja de colores grande x12', 'cuaderno layconsa cuadriculado 100 hojas', 'tomatodo', 'cinta de embalaje grande']) {
    assert.equal(decide(text).confidence, 'medium', text)
  }
})

test('si no existe, lo dice', () => {
  for (const text of ['calculadora casio cientifica', 'mochila escolar']) {
    const d = decide(text)
    assert.equal(d.confidence, 'low', text)
    assert.equal(d.best, null)
  }
})

test('un número que el producto no indica impide la seguridad alta', () => {
  assert.notEqual(decide('goma en barra 15 gramos').confidence, 'high')
})

test('sinónimos aprendidos entran en la búsqueda y deciden', () => {
  const markin = byName('Cuaderno Markin # 100 h')
  const docs = snapshot.map(d => d.id === markin.id ? { ...d, synonyms: ['el markin de siempre'] } : d)
  const d = search.decideMatch('el markin de siempre', search.retrieveLexical('el markin de siempre', docs), brands)
  assert.equal(d.best.doc.id, markin.id)
  assert.equal(d.confidence, 'high')
  assert.ok(d.best.learned)
})

test('el documento del índice no lleva precio ni stock', () => {
  const doc = productDocument({ name: 'Cuaderno Markin # 100 h', brand: 'Layconsa', category: 'Cuaderno', synonyms: ['markin 100 a4'] })
  assert.equal(doc, 'Cuaderno Markin # 100 h. Marca: Layconsa. Categoría: Cuaderno. También: markin 100 a4')
  assert.doesNotMatch(doc, /S\/|precio|stock/i)
})

test('precisión sobre los pedidos de prueba: sin falsos «seguros» y ≥ 90 % resueltos', () => {
  for (const file of ['agent-search-cases.json', 'agent-search-holdout.json']) {
    const cases = JSON.parse(readFileSync(new URL(`./fixtures/${file}`, import.meta.url)))
    let solved = 0, positives = 0
    for (const c of cases) {
      const d = decide(c.text.replace(/^vender\s+/i, ''))
      if (d.confidence === 'high') assert.ok(c.expected.includes(d.best.doc.id) || c.expect !== 'high' && c.expected.length > 0, `${file}: «${c.text}» marcó seguro un producto incorrecto`)
      if (c.expect === 'high') { positives++; if (d.confidence === 'high' && c.expected.includes(d.best.doc.id)) solved++ }
    }
    assert.ok(solved / positives >= 0.9, `${file}: ${solved}/${positives}`)
  }
})

test('agente 1: borrador con IDs reales, precio y stock cuando el pedido es claro (caso Markin)', async () => {
  const prepare = makeSalePreparer(catalogFrom(snapshot))
  const result = await prepare(sale('cuaderno markin cuadriculado 100 a4', 2), [], new Map())
  const markin = byName('Cuaderno Markin # 100 h')
  assert.equal(result.question, undefined)
  assert.deepEqual(result.draft, { customer_id: null, payment_method: 'efectivo', items: [{ product_id: markin.id, name: markin.name, qty: 2, unit_name: 'unidad', price_unit: 4.5, factor: 1, total: 9 }], total: 9, currency: 'PEN' })
  assert.equal(result.proposal.confidence, 'high')
  const [line] = result.proposal.items
  assert.equal(line.product_id, markin.id)
  assert.equal(line.stock_available, 20)
  assert.equal(line.confidence, 'high')
  assert.ok(line.reasons.length > 0)
})

test('agente 1: con dudas no hay draft; la propuesta preselecciona y lista solo candidatos reales', async () => {
  const prepare = makeSalePreparer(catalogFrom(snapshot))
  const result = await prepare(sale('caja de colores grande x12', 1), [], new Map())
  assert.equal(result.draft, undefined)
  assert.equal(result.proposal.confidence, 'medium')
  const [line] = result.proposal.items
  assert.ok(line.product_id)
  assert.ok(line.alternatives.length >= 2)
  const ids = new Set(snapshot.map(d => d.id))
  for (const option of [line.product_id, ...line.alternatives.map(a => a.product_id)]) assert.ok(ids.has(option))
  assert.match(result.question, /Hay varios productos igual de compatibles/)
  assert.ok(result.candidates.length >= 3)
})

test('agente 1: producto inexistente → seguridad baja, sin product_id', async () => {
  const prepare = makeSalePreparer(catalogFrom(snapshot))
  const result = await prepare(sale('calculadora casio', 1), [], new Map())
  assert.equal(result.proposal.confidence, 'low')
  assert.equal(result.proposal.items[0].product_id, null)
  assert.match(result.question, /no encontré «calculadora casio»/)
})

test('agente 1: falta la forma de pago o la cantidad → por confirmar', async () => {
  const prepare = makeSalePreparer(catalogFrom(snapshot))
  const noPay = await prepare({ ...sale('cuaderno markin cuadriculado 100 a4', 1), payment_method: null }, [], new Map())
  assert.equal(noPay.draft, undefined)
  assert.equal(noPay.proposal.confidence, 'medium')
  assert.equal(noPay.proposal.payment_method, null)
  const noQty = await prepare(sale('cuaderno markin cuadriculado 100 a4', null), [], new Map())
  assert.equal(noQty.proposal.items[0].qty, null)
  assert.equal(noQty.proposal.items[0].confidence, 'medium')
  assert.ok(noQty.proposal.items[0].product_id)
})

test('agente 1: el stock reservado por ventas por confirmar baja la seguridad', async () => {
  const prepare = makeSalePreparer(catalogFrom(snapshot))
  const markin = byName('Cuaderno Markin # 100 h')
  const result = await prepare(sale('cuaderno markin cuadriculado 100 a4', 5), [], new Map([[markin.id, 18]]))
  assert.equal(result.draft, undefined)
  assert.equal(result.proposal.items[0].stock_available, 2)
  assert.equal(result.proposal.confidence, 'medium')
  assert.match(result.question, /Stock insuficiente/)
})

test('agente 1: marca y atributos separados por el intérprete se suman a la búsqueda', async () => {
  const prepare = makeSalePreparer(catalogFrom(snapshot))
  const result = await prepare(sale('cuaderno', 1, { product: 'cuaderno', brand: 'markin', attributes: ['cuadriculado', '100 hojas'] }), [], new Map())
  assert.equal(result.proposal.items[0].name, 'Cuaderno Markin # 100 h')
  assert.equal(result.proposal.confidence, 'high')
})

test('preguntas de catálogo: responde con datos reales y dice cuando no hay', async () => {
  const answer = makeCatalogAnswerer(catalogFrom(snapshot))
  const yes = await answer({ intent: 'catalog_query', items: [{ query: 'cuadernos marking cuadriculados', sku: null, quantity: null, unit: null, product_id: null }], payment_method: null, customer_query: null, question: null })
  assert.match(yes.message, /Cuaderno Markin # 100 h \(Layconsa\): S\/ 4\.50 por unidad, quedan 20 unidad/)
  const no = await answer({ intent: 'catalog_query', items: [{ query: 'calculadora casio', sku: null, quantity: null, unit: null, product_id: null }], payment_method: null, customer_query: null, question: null })
  assert.match(no.message, /No encontré «calculadora casio»/)
  assert.equal(no.result.answers[0].found, false)
})

test('preguntas de catálogo: si el precio no está disponible no se inventa', async () => {
  const answer = makeCatalogAnswerer(catalogFrom(snapshot, { quote: async () => { throw new Error('sin precio') } }))
  const result = await answer({ intent: 'catalog_query', items: [{ query: 'cuaderno markin cuadriculado 100', sku: null, quantity: null, unit: null, product_id: null }], payment_method: null, customer_query: null, question: null })
  assert.match(result.message, /precio no disponible/)
})

test('el agente responde preguntas de catálogo sin vender ni reservar, y una pregunta no altera una venta por confirmar', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { randomUUID } = await import('node:crypto')
  const { makeSalesAgent } = await jiti.import('../server/modules/agent/app/salesAgent.ts')
  const { makeFileAgentStore } = await jiti.import('../server/modules/agent/infra/fileAgentStore.ts')
  const dir = await mkdtemp(join(tmpdir(), 'papeleria-agent1-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const catalog = catalogFrom(snapshot)
  const question = { intent: 'catalog_query', items: [{ query: 'cuaderno markin cuadriculado', sku: null, quantity: null, unit: null, product_id: null }], payment_method: null, customer_query: null, question: null }
  let next = question
  let executed = 0
  const agent = makeSalesAgent({
    store: makeFileAgentStore(dir),
    interpret: async () => next,
    prepare: makeSalePreparer(catalog),
    answer: makeCatalogAnswerer(catalog),
    execute: async () => { executed++; return { saleId: 's', total: 0 } }
  })
  const seller = { id: 'user-ana' }
  const msg = (text, extra = {}) => ({ protocol: 'yachay-agent/1', type: 'instruction', request_id: randomUUID(), input: { text }, ...extra })
  const answered = await agent(msg('¿tenemos cuadernos markin cuadriculados?'), seller)
  assert.equal(answered.status, 'completed')
  assert.equal(answered.result.kind, 'catalog_answer')
  assert.match(answered.message, /Cuaderno Markin # 100 h/)
  assert.equal(executed, 0)

  next = sale('caja de colores grande x12', 1)
  const review = await agent(msg('vende una caja de colores grande x12 efectivo'), seller)
  assert.equal(review.status, 'pending_review')
  assert.equal(review.result.proposal.confidence, 'medium')
  next = question
  const inside = await agent(msg('¿y cuadernos markin?', { type: 'follow_up', operation_id: review.operation_id }), seller)
  assert.equal(inside.result.kind, 'catalog_answer')
  const op = await makeFileAgentStore(dir).getOperation(review.operation_id)
  assert.equal(op.state, 'review')
  assert.equal(op.interpretation.intent, 'sale')
  assert.equal(executed, 0)
})

test('agente 1: un precio S/ 0 en el catálogo nunca se registra sin confirmar', async () => {
  const prepare = makeSalePreparer(catalogFrom(snapshot, { quote: async (p, qty, unit) => ({ unit_name: unit || p.unit, price: 0, factor: 1, currency: 'PEN' }) }))
  const result = await prepare(sale('cuaderno markin cuadriculado 100 a4', 1), [], new Map())
  assert.equal(result.draft, undefined)
  assert.equal(result.proposal.confidence, 'medium')
  assert.match(result.question, /precio S\/ 0\.00/)
})

test('si no hay coincidencia exacta, ofrece lo más parecido (Markin de 100 cuando piden 50)', async () => {
  const prepare = makeSalePreparer(catalogFrom(snapshot))
  const result = await prepare(sale('cuaderno markin cuadriculado 50 hojas', 1), [], new Map())
  assert.equal(result.proposal.confidence, 'low')
  assert.equal(result.proposal.items[0].product_id, null)
  assert.equal(result.proposal.items[0].alternatives[0].name, 'Cuaderno Markin # 100 h')
  assert.match(result.question, /el más parecido es Cuaderno Markin # 100 h \(50 hojas no coincide/)
})

test('ante un empate preselecciona el producto con stock disponible', async () => {
  const docs = snapshot
  const stock = { 'Faber Castell': 0, Artesco: 0, Layconsa: 9 }
  const base = catalogFrom(docs)
  const prepare = makeSalePreparer({ ...base, getProducts: async ids => (await base.getProducts(ids)).map(p => p.name === 'Caja de Colores Grande x12' ? { ...p, stock: stock[p.brand] } : p) })
  const result = await prepare(sale('caja de colores grande x12', 1), [], new Map())
  assert.equal(result.proposal.confidence, 'medium')
  assert.equal(result.proposal.items[0].brand, 'Layconsa')
})
