import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

// Agent 1: hybrid product matching, proposal contract and catalog answers (offline, no DB/OpenAI).
const requireNuxt = createRequire(import.meta.resolve('nuxt/package.json'))
const jiti = requireNuxt('jiti').createJiti(import.meta.url)
const search = await jiti.import('../server/modules/agent/app/productSearch.ts')
const { makeSalePreparer, matchQuery } = await jiti.import('../server/modules/agent/app/prepareSale.ts')
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
    customerExists: async () => false,
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
  assert.equal(decide('cuaderno markin triple renglon').best.doc.name, 'cuaderno markin triple renglón 100 h')
  assert.equal(decide('cuaderno surco rayado 100 hojas').best.doc.name, 'cuaderno surco rayado 100 h')
  const teens = decide('cuaderno layconsa teens rayado')
  assert.notEqual(teens.confidence, 'high')
})

test('A4/grande y A5/pequeño se tratan como tamaños compatibles o en conflicto', () => {
  assert.equal(decide('cuaderno anillado a4').best.doc.name, 'Cuaderno Anillado A4 100h')
  const small = decide('cuaderno surco pequeño 100h')
  assert.equal(small.confidence, 'high')
  assert.equal(small.best.doc.name, 'cuaderno surco pequeño 100 h')
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

test('agente 1: falta la forma de pago → por confirmar; sin cantidad se toma 1 (no es duda)', async () => {
  const prepare = makeSalePreparer(catalogFrom(snapshot))
  const noPay = await prepare({ ...sale('cuaderno markin cuadriculado 100 a4', 1), payment_method: null }, [], new Map())
  assert.equal(noPay.draft, undefined)
  assert.equal(noPay.proposal.confidence, 'medium')
  assert.equal(noPay.proposal.payment_method, null)
  const noQty = await prepare(sale('cuaderno markin cuadriculado 100 a4', null), [], new Map())
  assert.equal(noQty.proposal.items[0].qty, null) // process 2 records the default of 1
  assert.equal(noQty.proposal.items[0].confidence, 'high')
  assert.deepEqual(noQty.proposal.items[0].doubts, [])
  assert.equal(noQty.proposal.items[0].total, noQty.proposal.items[0].price_unit) // priced as 1
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

// ---- Contract with process 2: buildDraft → sale-draft/1 ----
const { makeHybridDraftBuilder, toSaleDraft } = await jiti.import('../server/modules/agent/app/draftBuilder.ts')
const { parseAgentDraft } = await jiti.import('../server/modules/agent/app/proposalAdapter.ts')
const { makeDraftValidator } = await jiti.import('../server/modules/agent/app/validateDraft.ts')
const interpreterReturning = (...results) => {
  const calls = []
  return { calls, interpret: async (messages, context) => { calls.push({ messages, context }); return results[Math.min(calls.length - 1, results.length - 1)] } }
}

test('buildDraft (caso Markin): sale-draft/1 válido para el proceso 2, que decide registro directo', async () => {
  const catalog = catalogFrom(snapshot)
  const { interpret } = interpreterReturning(sale('cuaderno markin cuadriculado 100 a4', 2))
  const draft = await makeHybridDraftBuilder(interpret, catalog)(['Vender 2 cuaderno markin cuadriculado 100 a4, efectivo'], null)
  const parsed = parseAgentDraft(draft, 'x')
  assert.equal(parsed.success, true)
  const markin = byName('Cuaderno Markin # 100 h')
  assert.deepEqual(parsed.data.items, [{ product_id: markin.id, candidates: parsed.data.items[0].candidates, quantity: 2, unit: null, price_unit: 4.5, price_said: null, confidence: 'high', doubts: [], query: 'cuaderno markin cuadriculado 100 a4' }])
  assert.equal(parsed.data.payment_method, 'efectivo')
  assert.deepEqual(parsed.data.doubts, [])
  const decision = await makeDraftValidator(catalog)(parsed.data, new Map())
  assert.equal(decision.kind, 'direct')
  assert.equal(decision.sale.total, 9)
})

test('buildDraft: empate → ambiguous_product con candidatos reales; el proceso 2 lo deja por confirmar', async () => {
  const catalog = catalogFrom(snapshot)
  const { interpret } = interpreterReturning(sale('caja de colores grande x12', 1))
  const draft = await makeHybridDraftBuilder(interpret, catalog)(['vende una caja de colores grande x12 efectivo'], null)
  assert.equal(parseAgentDraft(draft).success, true)
  const [line] = draft.items
  assert.equal(line.confidence, 'medium')
  assert.equal(line.doubts[0].code, 'ambiguous_product')
  assert.ok(line.doubts[0].note.length <= 300)
  assert.ok(line.candidates.length >= 2)
  const ids = new Set(snapshot.map(d => d.id))
  assert.ok([line.product_id, ...line.candidates].every(id => ids.has(id)))
  const decision = await makeDraftValidator(catalog)(draft, new Map())
  assert.equal(decision.kind, 'review')
})

test('buildDraft: códigos de duda (no encontrado, sin forma de pago); sin cantidad no es duda', async () => {
  const catalog = catalogFrom(snapshot)
  const order = { intent: 'sale', items: [
    { query: 'calculadora casio', sku: null, quantity: 1, unit: null, product_id: null },
    { query: 'cuaderno markin cuadriculado 100', sku: null, quantity: null, unit: null, product_id: null }
  ], payment_method: null, customer_query: null, question: null }
  const { interpret } = interpreterReturning(order)
  const draft = await makeHybridDraftBuilder(interpret, catalog)(['...'], null)
  assert.equal(parseAgentDraft(draft).success, true)
  assert.equal(draft.items[0].product_id, null)
  assert.equal(draft.items[0].doubts[0].code, 'product_not_found')
  assert.ok(draft.items[1].product_id)
  assert.equal(draft.items[1].quantity, null)
  assert.deepEqual(draft.items[1].doubts.map(d => d.code), [])
  assert.equal(draft.payment_method, null)
  assert.deepEqual(draft.doubts.map(d => d.code), ['missing_payment'])
})

test('buildDraft: en la aclaración solo acepta IDs de candidatos ofrecidos antes', async () => {
  const catalog = catalogFrom(snapshot)
  const first = await makeHybridDraftBuilder(interpreterReturning(sale('caja de colores grande x12', 1)).interpret, catalog)(['caja de colores grande x12 efectivo'], null)
  const faber = snapshot.find(p => p.name === 'Caja de Colores Grande x12' && p.brand === 'Faber Castell')
  const pick = interpreterReturning({ ...sale('caja de colores grande x12', 1), items: [{ query: 'caja de colores grande x12', sku: null, quantity: 1, unit: null, product_id: faber.id }] })
  const second = await makeHybridDraftBuilder(pick.interpret, catalog)(['caja de colores grande x12 efectivo', 'la de faber'], first)
  assert.ok(pick.calls[0].context.candidates.some(p => p.id === faber.id), 'el intérprete recibe las opciones reales')
  assert.equal(second.items[0].product_id, faber.id)
  assert.equal(second.items[0].confidence, 'high')
  const forged = interpreterReturning({ ...sale('x', 1), items: [{ query: 'x', sku: null, quantity: 1, unit: null, product_id: byName('Cuaderno Markin # 100 h').id }] })
  const third = await makeHybridDraftBuilder(forged.interpret, catalog)(['x'], first)
  assert.equal(third.items[0].product_id, null)
  assert.equal(third.items[0].doubts[0].code, 'product_not_found')
})

test('buildDraft: preguntas de catálogo → respuesta con datos reales (o unsupported si el proceso 2 no las atiende)', async () => {
  const catalog = catalogFrom(snapshot)
  const question = { intent: 'catalog_query', items: [{ query: 'cuadernos markin cuadriculados', sku: null, quantity: null, unit: null, product_id: null }], payment_method: null, customer_query: null, question: null }
  const off = await makeHybridDraftBuilder(interpreterReturning(question).interpret, catalog)(['¿tenemos cuadernos markin?'], null)
  assert.equal(off.intent, 'unsupported')
  assert.equal(parseAgentDraft(off).success, true)
  const on = await makeHybridDraftBuilder(interpreterReturning(question).interpret, catalog, { answerCatalogQuestions: true })(['¿tenemos cuadernos markin?'], null)
  assert.equal(on.kind, 'catalog_answer')
  assert.match(on.message, /Cuaderno Markin # 100 h/)
})

test('toSaleDraft: una línea "high" con dudas no se entrega como high', () => {
  const draft = toSaleDraft({ confidence: 'high', customer_id: null, payment_method: 'efectivo', total: 1, currency: 'PEN', doubts: [], order_doubts: [],
    items: [{ line: 1, query: 'q', product_id: 'p1', name: 'n', sku: null, brand: null, qty: 1, unit: null, unit_name: 'unidad', factor: 1, price_unit: 1, total: 1, stock_available: 1, confidence: 'high', match_score: 1, reasons: [], doubts: [{ code: 'other', note: 'x' }], alternatives: [] }] }, 'q')
  assert.equal(draft.items[0].confidence, 'medium')
})

test('política: un nombre exacto no basta si otro producto activo también coincide (diccionario bruno, papel lustre)', async () => {
  for (const [text, preferred] of [['diccionario bruno', 'Diccionario Bruno'], ['papel lustre', 'Papel Lustre'], ['regla de 30 cm', 'Reglas de 30 cm']]) {
    const d = decide(text)
    assert.equal(d.confidence, 'medium', text)
    assert.equal(d.best.doc.name, preferred, `${text}: se preselecciona el nombre exacto`)
    assert.match(d.doubts.join(' '), /varios productos igual de compatibles/)
  }
  const { interpret } = interpreterReturning(sale('diccionario bruno', 1))
  const draft = await makeHybridDraftBuilder(interpret, catalogFrom(snapshot))(['vende un diccionario bruno efectivo'], null)
  assert.equal(draft.items[0].confidence, 'medium')
  assert.equal(draft.items[0].doubts[0].code, 'ambiguous_product')
  assert.ok(draft.items[0].candidates.length >= 2)
  // Still high when a single product matches what the order says.
  assert.equal(decide('diccionario bruno de ingles').confidence, 'high')
})

// ---- Finding A2: a preselected product must never become a sale without the seller choosing it ----
const { explicitChoice } = await jiti.import('../server/modules/agent/app/sellerChoice.ts')

test('A2: «con yape» con el id preseleccionado copiado por el LLM → sigue ambiguo y el proceso 2 lo deja por confirmar', async () => {
  const catalog = catalogFrom(snapshot)
  const order = { ...sale('cuaderno rayado a4 100 hojas', 2), payment_method: null }
  const first = await makeHybridDraftBuilder(interpreterReturning(order).interpret, catalog)(['2 cuadernos rayados A4 100 hojas'], null)
  const [line] = first.items
  assert.equal(line.confidence, 'medium')
  assert.equal(line.doubts[0].code, 'ambiguous_product')
  assert.ok(line.product_id, 'hay un producto preseleccionado')
  // Simulated LLM: copies the preselected id and adds the payment method.
  const copying = interpreterReturning({ ...order, payment_method: 'yape', items: [{ ...order.items[0], product_id: line.product_id }] })
  const second = await makeHybridDraftBuilder(copying.interpret, catalogFrom(snapshot, {
    paymentMethods: async () => [{ code: 'yape', label: 'Yape' }, { code: 'efectivo', label: 'Efectivo' }]
  }))(['2 cuadernos rayados A4 100 hojas', 'con yape'], first)
  // The interpreter does not see the preselection as a choice.
  const shownLine = copying.calls[0].context.previous.items[0]
  assert.equal(shownLine.product_id, null)
  assert.equal(shownLine.candidates[0], line.product_id)
  assert.equal(second.payment_method, 'yape')
  assert.notEqual(second.items[0].confidence, 'high')
  assert.equal(second.items[0].doubts[0].code, 'ambiguous_product')
  const decision = await makeDraftValidator(catalogFrom(snapshot, { paymentMethods: async () => [{ code: 'yape', label: 'Yape' }] }))(second, new Map())
  assert.equal(decision.kind, 'review')
})

test('A2: una elección explícita (número de opción) sí resuelve la línea', async () => {
  const catalog = catalogFrom(snapshot)
  const order = sale('cuaderno rayado a4 100 hojas', 2)
  const first = await makeHybridDraftBuilder(interpreterReturning(order).interpret, catalog)(['2 cuadernos rayados A4 100 hojas efectivo'], null)
  const options = [first.items[0].product_id, ...first.items[0].candidates]
  const surco = snapshot.find(p => p.name === 'cuaderno surco rayado 100 h')
  const n = options.indexOf(surco.id) + 1
  assert.ok(n > 0)
  const picking = interpreterReturning({ ...order, items: [{ ...order.items[0], product_id: surco.id }] })
  const second = await makeHybridDraftBuilder(picking.interpret, catalog)(['2 cuadernos rayados A4 100 hojas efectivo', `la ${n}`], first)
  assert.equal(second.items[0].product_id, surco.id)
  assert.equal(second.items[0].confidence, 'high')
  assert.deepEqual(second.items[0].doubts, [])
})

test('explicitChoice: solo números de opción, SKU o una palabra que distinga una sola opción', () => {
  const offered = [
    { id: 'a', name: 'Caja de Colores Grande x12', brand: 'Artesco', sku: 'SKU-AAA1', unit: 'unidad', stock: 1 },
    { id: 'f', name: 'Caja de Colores Grande x12', brand: 'Faber Castell', sku: 'SKU-FFF2', unit: 'unidad', stock: 1 },
    { id: 'l', name: 'Caja de Colores Grande x12', brand: 'Layconsa', sku: 'SKU-LLL3', unit: 'unidad', stock: 1 }
  ]
  assert.equal(explicitChoice('la 2', offered), 'f')
  assert.equal(explicitChoice('opción 3, con yape', offered), 'l')
  assert.equal(explicitChoice('#1', offered), 'a')
  assert.equal(explicitChoice('el sku-fff2 por favor', offered), 'f')
  assert.equal(explicitChoice('la de faber', offered), 'f')
  assert.equal(explicitChoice('con yape', offered), null)
  assert.equal(explicitChoice('2', offered), null, 'un número suelto puede ser una cantidad')
  assert.equal(explicitChoice('son 2 cajas', offered), null)
  assert.equal(explicitChoice('caja de colores grande', offered), null, 'palabras comunes a todas no eligen')
  assert.equal(explicitChoice('la de faber o la layconsa', offered), null, 'elecciones contradictorias')
  assert.equal(explicitChoice('la 2, la de artesco', offered), null, 'número y nombre en conflicto')
  assert.equal(explicitChoice(undefined, offered), null)
})

test('buildDraft: con stock insuficiente un producto bien identificado sigue high y sin duda (el stock lo decide el proceso 2)', async () => {
  const base = catalogFrom(snapshot)
  const catalog = { ...base, getProducts: async ids => (await base.getProducts(ids)).map(p => ({ ...p, stock: 1 })) }
  const draft = await makeHybridDraftBuilder(interpreterReturning(sale('cuaderno markin cuadriculado 100 a4', 5)).interpret, catalog)(['5 cuadernos markin cuadriculado 100 a4 efectivo'], null)
  assert.equal(draft.items[0].confidence, 'high')
  assert.deepEqual(draft.items[0].doubts, [])
  assert.deepEqual(draft.doubts, [])
  const decision = await makeDraftValidator({ ...catalog, getProduct: async id => ({ ...(await base.getProduct(id)), stock: 1 }) })(draft, new Map())
  assert.equal(decision.kind, 'review')
  assert.deepEqual(decision.reasons.map(r => r.code), ['insufficient_stock'], 'un solo motivo, sin duplicados')
})

test('la cantidad que el intérprete dejó al inicio de la query no entra en la búsqueda (no baja la seguridad)', async () => {
  assert.equal(matchQuery({ query: 'dos cuadernos markin cuadriculado 100 a4', brand: null }), 'cuadernos markin cuadriculado 100 a4')
  assert.equal(matchQuery({ query: 'media docena de lapiceros', brand: null }), 'lapiceros')
  assert.equal(matchQuery({ query: '100 hojas bond', brand: null }), '100 hojas bond') // a description, kept
  const prepare = makeSalePreparer(catalogFrom(snapshot))
  const result = await prepare(sale('dos cuadernos markin cuadriculado 100 a4', 2), [], new Map())
  assert.equal(result.proposal.items[0].confidence, 'high')
  assert.equal(result.proposal.items[0].name, 'Cuaderno Markin # 100 h')
})

// ------------------------------------------------------------ corrections (independent review, 15 nov)

test('corrección stock: «¿cuántos quedan?» descuenta las unidades reservadas en ventas por confirmar', async () => {
  const markin = byName('Cuaderno Markin # 100 h')
  const ask = { intent: 'catalog_query', items: [{ query: 'cuaderno markin cuadriculado 100', sku: null, quantity: null, unit: null, product_id: null }], payment_method: null, customer_query: null, question: null }
  const base = catalogFrom(snapshot)
  const five = { ...base, getProducts: async ids => (await base.getProducts(ids)).map(p => ({ ...p, stock: p.id === markin.id ? 5 : p.stock })) }
  const held = await makeCatalogAnswerer(five, { reservedStock: async () => new Map([[markin.id, 3]]) })(ask)
  assert.match(held.message, /Cuaderno Markin # 100 h \(Layconsa\): S\/ 4\.50 por unidad, quedan 2 unidad disponibles \(5 en stock, 3 reservadas en ventas por confirmar\)/)
  const row = held.result.answers[0].products.find(p => p.product_id === markin.id)
  assert.deepEqual([row.stock, row.reserved, row.available], [5, 3, 2])
  const all = await makeCatalogAnswerer(five, { reservedStock: async () => new Map([[markin.id, 5]]) })(ask)
  assert.match(all.message, /sin unidades disponibles \(5 en stock, 5 reservadas/)
  // If the reservations cannot be read, it says the number does not discount them (never overstates silently).
  const unknown = await makeCatalogAnswerer(five, { reservedStock: async () => { throw new Error('store') } })(ask)
  assert.match(unknown.message, /quedan 5 unidad en stock \(sin descontar ventas por confirmar\)/)
})

test('corrección precio mayorista: sin cantidad de la IA («doce lapiceros…») cotiza con 12 como el proceso 2 y queda venta directa', async () => {
  const pilot = byName('Lapicero pilot azul')
  // Tiered price: from 12 units the wholesale price applies.
  const catalog = catalogFrom(snapshot, { quote: async (p, qty, unit) => ({ unit_name: unit || p.unit, price: qty >= 12 ? 0.8 : 1, factor: 1, currency: 'PEN' }) })
  const order = sale('lapicero pilot azul', null)
  const draft = await makeHybridDraftBuilder(interpreterReturning(order).interpret, catalog)(['doce lapiceros pilot azul, efectivo'], null)
  const [line] = draft.items
  assert.equal(line.product_id, pilot.id)
  assert.equal(line.price_unit, 0.8, 'precio del tramo mayorista, no el minorista de 1 unidad')
  const decision = await makeDraftValidator(catalog)(draft, new Map())
  assert.equal(decision.kind, 'direct', JSON.stringify(decision.reasons || decision))
  assert.equal(decision.sale.items[0].qty, 12)
  assert.equal(decision.sale.total, 9.6)
  // Without a written quantity it is still 1 at the retail price.
  const one = await makeHybridDraftBuilder(interpreterReturning(sale('lapicero pilot azul', null)).interpret, catalog)(['lapicero pilot azul, efectivo'], null)
  assert.equal(one.items[0].price_unit, 1)
})
