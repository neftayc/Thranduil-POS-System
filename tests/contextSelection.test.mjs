import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// Agent 1: product selection by CONTEXT (type, features, tolerant brand) over the catalog snapshot.
// Offline: no database, no OpenAI (the selector and the interpreter are mocks).
const requireNuxt = createRequire(import.meta.resolve('nuxt/package.json'))
const jiti = requireNuxt('jiti').createJiti(import.meta.url)
const search = await jiti.import('../server/modules/agent/app/productSearch.ts')
const conventions = await jiti.import('../server/modules/agent/app/catalogConventions.ts')
const { withContextSelection, clarifiedChoice, spokenHints, negatedTerms } = await jiti.import('../server/modules/agent/app/contextSelection.ts')
const { makeHybridDraftBuilder } = await jiti.import('../server/modules/agent/app/draftBuilder.ts')
const { makeDraftValidator } = await jiti.import('../server/modules/agent/app/validateDraft.ts')
const { makeSalesAgent } = await jiti.import('../server/modules/agent/app/salesAgent.ts')
const { makeFileAgentStore } = await jiti.import('../server/modules/agent/infra/fileAgentStore.ts')

const snapshot = JSON.parse(readFileSync(new URL('./fixtures/catalog-snapshot.json', import.meta.url)))
const brands = search.brandVocabulary(snapshot)
const byName = name => snapshot.find(p => p.name === name) || assert.fail(`no existe en el fixture: ${name}`)
const decide = text => search.decideMatch(text, search.retrieveLexical(text, snapshot), brands)
const eligible = d => d.ranked.filter(c => !c.conflicts.length && c.coverage >= 0.6)

const catalogFrom = docs => {
  const products = new Map(docs.map(d => [d.id, { id: d.id, name: d.name, sku: d.sku, brand: d.brand, unit: 'unidad', stock: 20 }]))
  return {
    searchProducts: async text => ({ docs: search.retrieveLexical(text, docs), brands: search.brandVocabulary(docs) }),
    getProducts: async ids => ids.map(id => products.get(id)).filter(Boolean),
    getProduct: async id => products.get(id) || null,
    findProducts: async (_q, sku) => [...products.values()].filter(p => p.sku === sku),
    findCustomers: async () => [],
    customerExists: async () => false,
    paymentMethods: async () => [{ code: 'efectivo', label: 'Efectivo' }, { code: 'yape', label: 'Yape' }],
    quote: async (p, qty, unit) => ({ unit_name: unit || p.unit, price: 4.5, factor: 1, currency: 'PEN' })
  }
}
const sale = (query, quantity = 2, extra = {}) => ({
  intent: 'sale', items: [{ query, sku: null, quantity, unit: null, product_id: null, ...extra }],
  payment_method: 'efectivo', customer_query: null, question: null
})
const interpreterReturning = (...results) => {
  const calls = []
  return { calls, interpret: async (messages, context) => { calls.push({ messages, context }); return results[Math.min(calls.length - 1, results.length - 1)] } }
}

// ------------------------------------------------------------ cases from the dry-run (14 nov)

test('«cuaderno marking 100 hojas cuadriculado» → Cuaderno Markin # 100 h (seguridad alta)', () => {
  const d = decide('cuaderno marking 100 hojas cuadriculado')
  assert.equal(d.confidence, 'high')
  assert.equal(d.best.doc.name, 'Cuaderno Markin # 100 h')
})

test('«cuaderno margen cuadriculado» (mal dictado) → Cuaderno Markin #', () => {
  // (the interpreter removes the quantity «dos cuadernos» before the search)
  for (const text of ['cuaderno margen cuadriculado', 'cuaderno margen 100 hojas cuadriculado', 'cuadernos margen 100 hojas cuadriculado']) {
    const d = decide(text)
    assert.equal(d.confidence, 'high', text)
    assert.equal(d.best.doc.name, 'Cuaderno Markin # 100 h', text)
  }
})

test('«cinta marking» → cinta masking: es otro tipo, nunca un cuaderno Markin', () => {
  const d = decide('cinta marking')
  assert.match(d.best.doc.name, /^Cinta Masking|^Cinta masking/)
  assert.ok(eligible(d).every(c => /cinta/i.test(c.doc.name)))
  const markin = d.ranked.find(c => c.doc.name === 'Cuaderno Markin # 100 h')
  assert.ok(!markin || markin.conflicts.some(c => /no cinta/.test(c)), 'un cuaderno queda fuera por tipo')
})

test('«cuaderno 100 hojas cuadriculado» sin marca → duda entre los «#» (no elige al azar)', () => {
  const d = decide('cuaderno 100 hojas cuadriculado')
  assert.equal(d.confidence, 'medium')
  const tied = search.tiedWithBest(d).map(c => c.doc.name)
  assert.ok(tied.length >= 3)
  assert.ok(tied.every(name => /# 100 h/.test(name)), tied.join('; '))
  assert.ok(tied.includes('Cuaderno Markin # 100 h'))
})

test('«cuaderno triple renglón markin» → cuaderno markin triple renglón 100 h', () => {
  const d = decide('cuaderno triple renglón markin')
  assert.equal(d.confidence, 'high')
  assert.equal(d.best.doc.name, 'cuaderno markin triple renglón 100 h')
})

test('«goma de borrar» → borradores, nunca goma en barra (pegamento)', () => {
  const d = decide('goma de borrar')
  assert.ok(d.best)
  assert.equal(byName(d.best.doc.name).category, 'Borrador')
  assert.ok(eligible(d).length >= 2 && eligible(d).every(c => byName(c.doc.name).category === 'Borrador'))
  assert.ok(!eligible(d).some(c => /goma en barra/i.test(c.doc.name)))
})

test('«papel bond a4» → Papel Bond (fixture con los nombres corregidos el 14 nov)', () => {
  const d = decide('papel bond a4')
  assert.equal(d.best.doc.name, 'Papel Bond')
  assert.ok(eligible(d).every(c => /papel bond/i.test(c.doc.name)))
})

test('convenciones: 1x1/2x2 = cuadrimax; # = cuadriculado; cuadrimax ≠ #', () => {
  const d = decide('cuaderno cuadrimax')
  const best = search.tiedWithBest(d)
  assert.equal(d.confidence, 'medium')
  assert.ok(best.length >= 2)
  assert.ok(best.every(c => /1x1|2x2/.test(c.doc.name)), best.map(c => c.doc.name).join('; '))
  assert.equal(decide('papel cuadriculado 1x1').best.doc.name, 'Papel Cuadriculado 1x1')
  const markin = decide('cuaderno markin cuadrimax').ranked.find(c => c.doc.name === 'Cuaderno Markin # 100 h')
  assert.ok(markin.conflicts.some(c => /cuadrimax/.test(c)))
})

test('tolerancia de dictado: marking/margen/markin suenan igual; masking es otra palabra', () => {
  const key = conventions.phoneticKey
  assert.equal(key('marking'), key('markin'))
  assert.equal(key('margen'), key('markin'))
  assert.notEqual(key('masking'), key('markin'))
  assert.equal(search.similarWord('margen', 'markin'), true)
  assert.equal(search.similarWord('masking', 'margen'), false)
})

// ------------------------------------------------------------ LLM selector (mock)

test('selector: elige solo entre los candidatos igual de compatibles; no sube a high ni inventa', async () => {
  const d = decide('cuaderno 100 hojas cuadriculado')
  const tied = search.tiedWithBest(d)
  const target = tied.find(c => c.doc.name === 'cuaderno layconsa teens # 100 h')
  const seen = []
  const selector = async (line, candidates) => { seen.push({ line, candidates }); return { product_id: target.doc.id, confidence: 'high', reason: 'el vendedor dijo teens' } }
  const picked = await withContextSelection('cuaderno 100 hojas cuadriculado', d, selector)
  assert.equal(picked.best.doc.id, target.doc.id)
  assert.equal(picked.selected, target.doc.id)
  assert.equal(picked.confidence, 'medium', 'un empate real sigue con duda')
  assert.ok(seen[0].candidates.every(c => tied.some(t => t.doc.id === c.product_id)))
  // Unknown id, null pick or a failing call → the deterministic decision stays.
  for (const bad of [async () => ({ product_id: 'inventado', confidence: 'high', reason: '' }), async () => ({ product_id: null, confidence: 'low', reason: 'falta la marca' }), async () => { throw new Error('timeout') }]) {
    const same = await withContextSelection('cuaderno 100 hojas cuadriculado', d, bad)
    assert.equal(same, d)
  }
  // A unique match never calls the selector (no extra cost).
  let called = 0
  await withContextSelection('x', decide('cuaderno marking 100 hojas cuadriculado'), async () => { called++; return { product_id: null, confidence: 'low', reason: '' } })
  assert.equal(called, 0)
})

test('buildDraft con selector: la preselección es la del selector y sigue como ambiguous_product', async () => {
  const catalog = catalogFrom(snapshot)
  const teens = byName('cuaderno layconsa teens # 100 h')
  const selector = async (_line, candidates) => ({ product_id: candidates.find(c => c.product_id === teens.id).product_id, confidence: 'medium', reason: 'prueba' })
  const draft = await makeHybridDraftBuilder(interpreterReturning(sale('cuaderno 100 hojas cuadriculado', 2)).interpret, catalog, { selector })(['dos cuadernos 100 hojas cuadriculado efectivo'], null)
  assert.equal(draft.items[0].product_id, teens.id)
  assert.equal(draft.items[0].confidence, 'medium')
  assert.equal(draft.items[0].doubts[0].code, 'ambiguous_product')
  assert.match(draft.items[0].doubts[0].note, /Sugerencia por contexto/)
})

// ------------------------------------------------------------ seller clarification

test('aclaración «es el Markin» resuelve la línea aunque el intérprete no copie el id ni cambie la consulta', async () => {
  const catalog = catalogFrom(snapshot)
  const markin = byName('Cuaderno Markin # 100 h')
  const first = await makeHybridDraftBuilder(interpreterReturning(sale('cuaderno 100 hojas cuadriculado', 2)).interpret, catalog)(['dos cuadernos 100 hojas cuadriculado efectivo'], null)
  assert.equal(first.items[0].confidence, 'medium')
  assert.ok([first.items[0].product_id, ...first.items[0].candidates].includes(markin.id), 'Markin estaba entre las opciones')
  for (const reply of ['es el Markin', 'es el margen', 'el marking']) {
    const second = await makeHybridDraftBuilder(interpreterReturning(sale('cuaderno 100 hojas cuadriculado', 2)).interpret, catalog)(['dos cuadernos 100 hojas cuadriculado efectivo', reply], first)
    assert.equal(second.items[0].product_id, markin.id, reply)
    assert.equal(second.items[0].confidence, 'high', reply)
    assert.deepEqual(second.items[0].doubts, [], reply)
    assert.equal((await makeDraftValidator(catalog)(second, new Map())).kind, 'direct', reply)
  }
})

test('aclaración: si el intérprete suma la marca a la consulta, la nueva búsqueda también lo resuelve', async () => {
  const catalog = catalogFrom(snapshot)
  const first = await makeHybridDraftBuilder(interpreterReturning(sale('cuaderno margen 100 hojas cuadriculado', 2)).interpret, catalog)(['dos cuadernos margen'], null)
  const second = await makeHybridDraftBuilder(interpreterReturning(sale('cuaderno 100 hojas cuadriculado', 2, { brand: 'Markin' })).interpret, catalog)(['dos cuadernos', 'es el Markin'], first)
  assert.equal(second.items[0].product_id, byName('Cuaderno Markin # 100 h').id)
  assert.equal(second.items[0].confidence, 'high')
})

test('aclaración segura (A2): no elige algo que contradice la línea ni fuera de sus opciones', async () => {
  const catalog = catalogFrom(snapshot)
  const opts = ['cuaderno surco # 100 h', 'Cuaderno Markin # 100 h', 'cuaderno layconsa teens # 100 h'].map(byName).map(d => ({ ...d, unit: 'unidad', stock: 20 }))
  // «el surco rayado»: surco is distinctive, but «rayado» contradicts «surco #».
  assert.equal(clarifiedChoice('el surco rayado', opts, opts, 'cuaderno surco rayado 100 hojas'), null)
  assert.equal(clarifiedChoice('el surco', opts, opts, 'cuaderno 100 hojas cuadriculado').product.name, 'cuaderno surco # 100 h')
  // Replies that do not name an option.
  for (const reply of ['con yape', '2', 'cuaderno 100 hojas']) assert.equal(clarifiedChoice(reply, opts, opts, 'cuaderno 100 hojas cuadriculado'), null, reply)
  // An option of ANOTHER line is not a choice for this one.
  assert.equal(clarifiedChoice('la 2', opts, [opts[0]], 'cuaderno 100 hojas cuadriculado'), null)
  // Through buildDraft: «con yape» leaves the line ambiguous.
  const first = await makeHybridDraftBuilder(interpreterReturning(sale('cuaderno 100 hojas cuadriculado', 2)).interpret, catalog)(['dos cuadernos 100 hojas cuadriculado'], null)
  const second = await makeHybridDraftBuilder(interpreterReturning(sale('cuaderno 100 hojas cuadriculado', 2)).interpret, catalog)(['dos cuadernos 100 hojas cuadriculado', 'con yape'], first)
  assert.notEqual(second.items[0].confidence, 'high')
})

// ------------------------------------------------------------ dry-run end to end (mocks)

test('dry-run con mocks: «dos cuadernos margen 100 hojas cuadriculado» → se habría registrado Markin, sin create_sale', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'papeleria-context-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const catalog = catalogFrom(snapshot)
  const calls = { execute: 0 }
  const order = sale('cuaderno margen 100 hojas cuadriculado', 2)
  const agent = makeSalesAgent({
    store: makeFileAgentStore(dir),
    buildDraft: makeHybridDraftBuilder(interpreterReturning(order).interpret, catalog, { selector: async () => { throw new Error('no debe hacer falta') } }),
    validate: makeDraftValidator(catalog),
    execute: async () => { calls.execute++; throw new Error('create_sale NO debe llamarse en dry-run') },
    dryRun: true
  })
  const response = await agent({ protocol: 'yachay-agent/1', type: 'instruction', request_id: randomUUID(), input: { text: 'dos cuadernos margen 100 hojas cuadriculado, efectivo', locale: 'es-PE' } }, { id: 'user-ana' })
  assert.equal(calls.execute, 0)
  assert.equal(response.result.dry_run, true)
  assert.equal(response.result.would_be, 'completed')
  assert.equal(response.result.total, 9)
  assert.match(JSON.stringify(response), /Cuaderno Markin # 100 h/)
})

// ------------------------------------------------------------ the brand the interpreter dropped (dry-run 14 nov)

// What the real interpreter returned in the dry-run: brand lost, query without it.
const lostBrand = (quantity, payment = null) => ({ ...sale('cuaderno 100 hojas cuadriculado', quantity, { brand: null }), payment_method: payment })

test('spokenHints: recupera «marca X» y palabras dichas que no llegaron a la línea; ignora cantidad y pago', () => {
  assert.deepEqual(spokenHints('Cuadernos de 100 hojas, marca margen cuadriculado.', lostBrand(null)), ['margen'])
  assert.deepEqual(spokenHints('Dos cuadernos cuadriculados marca marking de 100 hojas.', lostBrand(2)), ['marking'])
  assert.deepEqual(spokenHints('dos cuadernos 100 hojas cuadriculado, efectivo', lostBrand(2, 'efectivo')), [])
})

test('ensayo real: «Cuadernos de 100 hojas, marca margen cuadriculado.» → Cuaderno Markin # 100 h aunque el intérprete pierda la marca', async () => {
  const text = 'Cuadernos de 100 hojas, marca margen cuadriculado.'
  const draft = await makeHybridDraftBuilder(interpreterReturning(lostBrand(null)).interpret, catalogFrom(snapshot))([text], null)
  assert.equal(draft.items[0].product_id, byName('Cuaderno Markin # 100 h').id)
  assert.deepEqual(draft.items[0].doubts.map(d => d.code), [], 'sin cantidad dicha se vende 1 (Proceso 2): no queda duda')
})

test('ensayo real: «Dos cuadernos cuadriculados marca marking de 100 hojas.» → 2 × Cuaderno Markin # 100 h', async () => {
  const text = 'Dos cuadernos cuadriculados marca marking de 100 hojas.'
  const draft = await makeHybridDraftBuilder(interpreterReturning(lostBrand(2)).interpret, catalogFrom(snapshot))([text], null)
  const [line] = draft.items
  assert.equal(line.product_id, byName('Cuaderno Markin # 100 h').id)
  assert.equal(line.quantity, 2)
  assert.equal(line.confidence, 'high')
  assert.deepEqual(line.doubts, [])
  assert.equal(draft.payment_method, 'efectivo', 'el dictado no dijo la forma de pago: efectivo por defecto')
  assert.deepEqual(draft.doubts, [])
})

test('una pista nunca empeora la elección: palabras ajenas no producen un «high» y no se usan en pedidos de varias líneas', async () => {
  const catalog = catalogFrom(snapshot)
  const noise = await makeHybridDraftBuilder(interpreterReturning(lostBrand(2, 'efectivo')).interpret, catalog)(['dos cuadernos 100 hojas cuadriculado para mi hijo, efectivo'], null)
  assert.equal(noise.items[0].confidence, 'medium')
  const two = { ...lostBrand(2, 'efectivo'), items: [...lostBrand(2).items, { query: 'cinta masking', sku: null, quantity: 1, unit: null, product_id: null }] }
  const multi = await makeHybridDraftBuilder(interpreterReturning(two).interpret, catalog)(['dos cuadernos marca markin 100 hojas cuadriculado y una cinta masking, efectivo'], null)
  assert.equal(multi.items[0].confidence, 'medium', 'con varias líneas no se sabe a cuál pertenece la palabra')
})

test('criterio de éxito (dry-run con mocks): «dos cuadernos marking 100 hojas cuadriculado, efectivo» → 2 × Markin, venta directa, sin preguntas', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'papeleria-context-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const catalog = catalogFrom(snapshot)
  const calls = { execute: 0, selector: 0 }
  // Worst case: the interpreter drops «marking» again.
  for (const order of [lostBrand(2, 'efectivo'), sale('cuaderno marking 100 hojas cuadriculado', 2, { brand: 'marking' })]) {
    const agent = makeSalesAgent({
      store: makeFileAgentStore(join(dir, String(calls.execute + Math.random()))),
      buildDraft: makeHybridDraftBuilder(interpreterReturning(order).interpret, catalog, { selector: async () => { calls.selector++; return { product_id: null, confidence: 'low', reason: '' } } }),
      validate: makeDraftValidator(catalog),
      execute: async () => { calls.execute++; throw new Error('create_sale NO debe llamarse en dry-run') },
      dryRun: true
    })
    const response = await agent({ protocol: 'yachay-agent/1', type: 'instruction', request_id: randomUUID(), input: { text: 'dos cuadernos marking 100 hojas cuadriculado, efectivo', locale: 'es-PE' } }, { id: 'user-ana' })
    assert.equal(response.result.dry_run, true)
    assert.equal(response.result.would_be, 'completed', JSON.stringify(response.result))
    assert.equal(response.result.total, 9)
    assert.match(JSON.stringify(response), /Cuaderno Markin # 100 h/)
  }
  assert.equal(calls.execute, 0)
  assert.equal(calls.selector, 0, 'una venta inequívoca no llama al selector (sin costo ni latencia extra)')
})

// ------------------------------------------------------------ real dry-run of 15 nov: clarification with a negation

const M1 = 'Dos cartulinas blancas, un lapicero Faber-Castell azul de un sol, un cartón cartulina, tres cartulinas a colores, dos plumones Faber-Castell para pisar.'
const M2 = 'La cartulina es la cartulina a color. En ningún momento dijimos A4. En cuanto a los plumones, vamos a vender el W47.'
// What the interpreter returns for M1 (and keeps for M2): five lines, the dictated price on the pen.
const ORDER_15NOV = {
  intent: 'sale', payment_method: null, customer_query: null, question: null,
  items: [['cartulina blanca', 2], ['lapicero Faber-Castell azul', 1, 1], ['cartón cartulina', 1], ['cartulinas a colores', 3], ['plumones Faber-Castell para pisar', 2]]
    .map(([query, quantity, price = null]) => ({ query, sku: null, quantity, unit: null, product_id: null, price }))
}
// List prices: the 060 pen is S/ 2.00 (as in the dry-run), the Trilux Azul-032 is S/ 1.00.
const priced = () => ({
  ...catalogFrom(snapshot),
  quote: async (p, qty, unit) => ({ unit_name: unit || p.unit, price: /Trilux Azul/.test(p.name) ? 1 : /060/.test(p.name) ? 2 : 4.5, factor: 1, currency: 'PEN' })
})
const nameOf = id => snapshot.find(p => p.id === id)?.name

test('negatedTerms: «en ningún momento dijimos A4», «no es A4», «sin espiral», «no el rayado»', () => {
  assert.deepEqual(negatedTerms(M2), ['a4'])
  assert.deepEqual(negatedTerms('no es A4'), ['a4'])
  assert.deepEqual(negatedTerms('el cuaderno sin espiral, no el rayado'), ['espiral', 'rayado'])
  assert.deepEqual(negatedTerms('no, mejor el surco'), [])
})

test('BUG 15 nov: tras «En ningún momento dijimos A4» la línea 4 es «Cartulina a colores», nunca la A4', async () => {
  const catalog = priced()
  const first = await makeHybridDraftBuilder(interpreterReturning(ORDER_15NOV).interpret, catalog)([M1], null)
  assert.equal(nameOf(first.items[3].product_id), 'Cartulina a colores', 'la coincidencia casi exacta va primero')
  const second = await makeHybridDraftBuilder(interpreterReturning(ORDER_15NOV).interpret, catalog)([M1, M2], first)
  const line = second.items[3]
  assert.equal(nameOf(line.product_id), 'Cartulina a colores')
  assert.ok(![line.product_id, ...line.candidates].some(id => /A4/.test(nameOf(id))), 'la A4 queda excluida, ni siquiera como opción')
  // Even if the interpreter re-adds A4 to the search text, the affirmative line asks for it; but if it copies the A4 id it is not a seller choice.
  const a4 = snapshot.find(p => p.name === 'cartulinas de pliego a color A4')
  const forged = { ...ORDER_15NOV, items: ORDER_15NOV.items.map((it, i) => i === 3 ? { ...it, product_id: a4.id } : it) }
  const third = await makeHybridDraftBuilder(interpreterReturning(forged).interpret, catalog)([M1, M2], first)
  assert.notEqual(third.items[3].product_id === a4.id && third.items[3].confidence === 'high', true, 'la A4 nunca sale con seguridad alta')
})

test('una aclaración ambigua nunca da seguridad alta (ni por una palabra que solo distingue entre lo ofrecido)', async () => {
  const catalog = catalogFrom(snapshot)
  const first = await makeHybridDraftBuilder(interpreterReturning(sale('plumones', 1)).interpret, catalog)(['un plumón, efectivo'], null)
  assert.notEqual(first.items[0].confidence, 'high')
  for (const reply of ['el de color', 'el plumón', 'el W47', 'ese']) {
    const second = await makeHybridDraftBuilder(interpreterReturning(sale('plumones', 1)).interpret, catalog)(['un plumón, efectivo', reply], first)
    assert.notEqual(second.items[0].confidence, 'high', reply)
  }
  // An option number is unequivocal.
  const numbered = await makeHybridDraftBuilder(interpreterReturning(sale('plumones', 1)).interpret, catalog)(['un plumón, efectivo', 'la 2'], first)
  assert.equal(numbered.items[0].confidence, 'high')
})

test('precio dictado como pista: «lapicero Faber-Castell azul de un sol» → el único de S/ 1.00 (Trilux Azul-032)', async () => {
  const draft = await makeHybridDraftBuilder(interpreterReturning(ORDER_15NOV).interpret, priced())([M1], null)
  const line = draft.items[1]
  assert.equal(nameOf(line.product_id), 'Lapicero Trilux Azul-032')
  assert.equal(line.confidence, 'high')
  assert.equal(line.price_unit, 1)
  // Without the dictated price it stays a doubt between the Faber-Castell blue pens.
  const noPrice = { ...ORDER_15NOV, items: [{ ...ORDER_15NOV.items[1], price: null }] }
  const plain = await makeHybridDraftBuilder(interpreterReturning(noPrice).interpret, priced())(['un lapicero Faber-Castell azul'], null)
  assert.equal(plain.items[0].confidence, 'medium')
  // A price that two candidates share does not decide; a price no candidate has does not either.
  for (const price of [4.5, 7]) {
    const other = { ...ORDER_15NOV, items: [{ ...ORDER_15NOV.items[1], price }] }
    const d = await makeHybridDraftBuilder(interpreterReturning(other).interpret, priced())(['un lapicero Faber-Castell azul'], null)
    assert.equal(d.items[0].confidence, 'medium', String(price))
  }
})

test('tipo: «cartulinas a colores» nunca propone «Folder a color de cartulina»', async () => {
  const d = decide('cartulinas a colores')
  const folder = d.ranked.find(c => c.doc.name === 'Folder a color de cartulina')
  assert.ok(!folder || folder.excluded, 'el folder es de otro tipo')
  const draft = await makeHybridDraftBuilder(interpreterReturning(sale('cartulinas a colores', 3)).interpret, catalogFrom(snapshot))(['tres cartulinas a colores'], null)
  assert.ok(![draft.items[0].product_id, ...draft.items[0].candidates].some(id => /Folder/.test(nameOf(id))))
})

test('dictado en características: «plumones para pisar» → pizarra (o duda entre pizarras), nunca papel con seguridad alta', () => {
  for (const text of ['plumones Faber-Castell para pisar', 'plumones para pisar', 'plumón de pisarra']) {
    const d = decide(text)
    assert.match(d.best.doc.name, /Pizarra/, text)
    if (d.confidence === 'high') assert.ok(!/papel/i.test(d.best.doc.name), text)
    assert.ok(search.tiedWithBest(d).every(c => /Pizarra/.test(c.doc.name)), text)
  }
})

test('pago por defecto: «dos cartulinas blancas» sin pago → borrador con efectivo y sin duda de pago; «transferencia» se respeta', async () => {
  const catalog = { ...catalogFrom(snapshot), paymentMethods: async () => [{ code: 'efectivo', label: 'Efectivo' }, { code: 'transferencia', label: 'Transferencia' }] }
  const draft = await makeHybridDraftBuilder(interpreterReturning({ ...sale('cartulina blanca', 2), payment_method: null }).interpret, catalog)(['dos cartulinas blancas'], null)
  assert.equal(draft.payment_method, 'efectivo')
  assert.deepEqual(draft.doubts, [])
  assert.equal(draft.items[0].confidence, 'high')
  const transfer = await makeHybridDraftBuilder(interpreterReturning({ ...sale('cartulina blanca', 2), payment_method: 'transferencia' }).interpret, catalog)(['dos cartulinas blancas por transferencia'], null)
  assert.equal(transfer.payment_method, 'transferencia')
})
