import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

// Step 2, sales selector: deterministic parts (catalog text, guards, contract) with a mock model. Offline.
const requireNuxt = createRequire(import.meta.resolve('nuxt/package.json'))
const jiti = requireNuxt('jiti').createJiti(import.meta.url)
const sel = await jiti.import('../server/modules/agent/app/salesSelector.ts')
const { buildSelectorCatalog } = await jiti.import('../server/modules/agent/infra/supabaseSelectorCatalog.ts')

const catalog = JSON.parse(readFileSync(new URL('./fixtures/selector-catalog.json', import.meta.url)))
const golden = JSON.parse(readFileSync(new URL('./fixtures/golden-dictados.json', import.meta.url)))
const byName = name => catalog.products.find(p => p.name === name) || assert.fail(`no existe: ${name}`)
const { toRef } = sel.referencesFor(catalog.products)
const ref = name => toRef.get(byName(name).id)
const line = (over = {}) => ({ phrase: 'x', product_ref: null, quantity: null, unit: null, price_said: null, confidence: 'alta', reason: 'r', question: null, options: [], ...over })
const output = (lines, over = {}) => ({ intent: 'venta', lines, payment_method: 'efectivo', payment_phrase: null, questions: [], ...over })

test('catálogo compacto: agrupado por tipo, con referencia corta, presentaciones con precio y stock; sin uuids ni costos', () => {
  const text = sel.catalogText(catalog)
  assert.match(text, /^## /m)
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-/.test(text), 'el modelo no ve uuids')
  assert.ok(!/cost/i.test(text))
  const markin = text.split('\n').find(l => l.includes('Cuaderno Markin # 100 h'))
  assert.match(markin, /^p\d+ \| Cuaderno Markin # 100 h \| Layconsa \| unidad S\/4\.5; medio_ciento\(x50\) S\/225 \| stock 21$/)
  // Every product of a type sits under its heading.
  const sections = text.split(/^## /m).filter(Boolean)
  const cuadernos = sections.find(s => s.startsWith('Cuaderno\n'))
  assert.ok(cuadernos.includes('Cuaderno Markin # 100 h') && cuadernos.includes('cuaderno surco # 100 h'))
  // About 424 products in a few thousand tokens (≈ 3.5 chars per token).
  assert.equal(catalog.products.length, 424)
  assert.ok(sel.selectorSystemPrompt(catalog).length / 3.5 < 16000)
})

test('guardias: referencias → ids reales; una referencia inventada se vuelve pregunta; «alta» exige producto', () => {
  const c = sel.toConsolidated(output([
    line({ phrase: 'dos cuadernos markin cuadriculados', product_ref: ref('Cuaderno Markin # 100 h'), quantity: 2 }),
    line({ phrase: 'un unicornio', product_ref: 'p99999' }),
    line({ phrase: 'algo', product_ref: null, confidence: 'alta' })
  ]), catalog)
  assert.equal(c.contract, 'sale-consolidated/1')
  assert.deepEqual([c.lines[0].product_id, c.lines[0].quantity, c.lines[0].confidence], [byName('Cuaderno Markin # 100 h').id, 2, 'alta'])
  assert.equal(c.lines[1].product_id, null)
  assert.equal(c.lines[1].confidence, 'baja')
  assert.match(c.lines[1].question, /No identifiqué/)
  assert.equal(c.lines[2].confidence, 'baja')
  assert.ok(c.lines[2].question)
})

test('guardias: una línea «baja» lleva pregunta y opciones reales (la propuesta primero); sin cantidad → 1', () => {
  const c = sel.toConsolidated(output([line({
    phrase: 'una goma en barra, la icona', product_ref: ref('Goma en barra 21Gr'), confidence: 'baja', question: '¿8 g o 21 g?',
    options: [ref('Goma en barra 8 gr'), 'p0', ref('Goma en barra 8 gr')]
  })]), catalog)
  const [l] = c.lines
  assert.equal(l.quantity, 1)
  assert.equal(l.question, '¿8 g o 21 g?')
  assert.deepEqual(l.options, [byName('Goma en barra 21Gr').id, byName('Goma en barra 8 gr').id])
})

test('pago: sin pago → efectivo; un pago dicho que existe se respeta; uno dicho que no existe → pregunta', () => {
  assert.equal(sel.toConsolidated(output([], { payment_method: '' }), catalog).payment_method, 'efectivo')
  const yape = sel.toConsolidated(output([], { payment_method: 'Yape', payment_phrase: 'con yape' }), catalog)
  assert.deepEqual([yape.payment_method, yape.payment_phrase, yape.questions], ['yape', 'con yape', []])
  const bad = sel.toConsolidated(output([], { payment_method: 'bitcoin', payment_phrase: 'en bitcoin' }), catalog)
  assert.match(bad.questions[0], /forma de pago/)
})

test('selector: prefijo fijo cacheado por versión del catálogo; el consolidado previo viaja con referencias, nunca uuids', async () => {
  const calls = []
  const markin = ref('Cuaderno Markin # 100 h')
  const model = async (system, user) => { calls.push({ system, user }); return { output: output([line({ phrase: 'dos cuadernos marking', product_ref: markin, quantity: 2 })]), usage: { input_tokens: 10, cached_tokens: 0, output_tokens: 5, latency_ms: 1, model: 'mock' } } }
  const select = sel.makeSalesSelector({ model, catalog: async () => catalog })
  const first = await select({ messages: ['dos cuadernos marking'] })
  assert.equal(first.consolidated.lines[0].product_id, byName('Cuaderno Markin # 100 h').id)
  await select({ messages: ['dos cuadernos marking', 'con yape'], previous: first.consolidated })
  assert.equal(calls[0].system, calls[1].system, 'mismo prefijo → caché de prompts')
  assert.ok(calls[1].user.includes(`"product_id":"${markin}"`))
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-/.test(calls[1].user))
  // A new catalog version rebuilds the prefix.
  await sel.makeSalesSelector({ model, catalog: async () => ({ ...catalog, version: 'otra', products: catalog.products.slice(1) }) })({ messages: ['x'] })
  assert.notEqual(calls[2].system, calls[0].system)
})

test('reglas y ejemplos en el prefijo: cantidad antes del producto, códigos de modelo, dictado de marcas, efectivo por defecto', () => {
  const system = sel.selectorSystemPrompt(catalog)
  for (const rule of [/la cantidad va SIEMPRE PRIMERO/, /060, 123, «de 250»/, /iconza/, /de cartel/, /margen/, /efectivo/, /NO agrega atributos/, /negación/]) assert.match(system, rule)
  assert.match(system, /Ejemplos aprendidos/)
  // The learned examples never repeat a benchmark dictation.
  for (const c of golden.cases) for (const m of c.messages) assert.ok(!system.includes(m), `el ejemplo repite ${c.id}`)
})

test('catálogo: stock menos reservas, precio por presentación o base × factor, versión por contenido', () => {
  const rows = {
    products: [{ id: 'a', name: 'Lapiz', brand: 'X,', product_type: 'Lapiz', unit: 'unidad', sale_price: 1, stock_on_hand: 10, updated_at: '2026-11-15' }],
    conversions: [{ product_id: 'a', unit_name: 'docena', factor_to_base: 12 }, { product_id: 'a', unit_name: 'caja', factor_to_base: 50 }],
    presentationPrices: [{ product_id: 'a', unit_name: 'docena', price_uom: 11 }],
    tiers: [], payments: [{ code: 'efectivo', label: 'Efectivo' }]
  }
  const built = buildSelectorCatalog(rows, new Map([['a', 3]]))
  assert.deepEqual(built.products[0].presentations, [{ unit: 'unidad', factor: 1, price: 1 }, { unit: 'docena', factor: 12, price: 11 }, { unit: 'caja', factor: 50, price: 50 }])
  assert.equal(built.products[0].stock, 7)
  assert.equal(built.products[0].brand, 'X')
  assert.equal(built.version, buildSelectorCatalog(rows, new Map([['a', 3]])).version)
  assert.notEqual(built.version, buildSelectorCatalog(rows).version, 'otra reserva → otra versión')
})

test('interruptor POS_AGENT_SELECTOR: legacy por defecto; solo «llm» activa el selector nuevo', () => {
  for (const v of [undefined, '', 'legacy', 'otro', 'LLM ']) assert.equal(sel.selectorMode(v), v === 'LLM ' ? 'llm' : 'legacy')
  assert.equal(sel.selectorMode('llm'), 'llm')
})

test('golden-dictados.json: todos los productos esperados existen en el snapshot y las aclaraciones apuntan a un caso previo', () => {
  const names = new Set(catalog.products.map(p => p.name))
  for (const c of golden.cases) {
    if (c.follows) assert.ok(golden.cases.some(d => d.id === c.follows), c.id)
    for (const l of c.lines) for (const n of [l.product, ...(l.options || []), l.also_ok?.product].filter(Boolean)) assert.ok(names.has(n), `${c.id}: ${n}`)
  }
})

test('verificación determinista: una «alta» que contradice lo dicho baja a pregunta con opciones reales', () => {
  const decide = (phrase, name, messages = [phrase], price = null) => sel.toConsolidated(output([line({ phrase, product_ref: ref(name), quantity: 1, price_said: price })]), catalog, messages).lines[0]
  // Hard: another model code (060 ≠ 032). Soft: «Trilux» said and the 060 is not a Trilux.
  for (const name of ['Lapicero Trilux Azul-032', 'Lapicero 060 - Azul, Rojo']) {
    const l = decide('Un lapicero Trilux 060 azul', name)
    assert.equal(l.confidence, 'baja', name)
    assert.ok(l.options.length >= 2 && l.options.includes(byName(name).id))
  }
  // Soft: «blancas» said, the pick is «a colores» (a sibling is blanca).
  assert.equal(decide('Dos cartulinas blancas', 'Cartulina a colores').confidence, 'baja')
  // Tie: nothing distinguishes the cuadernos # 100 h → question with the tied ones.
  const tie = decide('vender cuader a4 100 cuadriculado', 'Cuaderno Markin # 100 h')
  assert.equal(tie.confidence, 'baja')
  assert.ok(tie.options.includes(byName('cuaderno surco # 100 h').id))
})

test('verificación determinista: no baja lo que está bien (precio dictado, marcas dictadas, código de modelo, aclaración explícita)', () => {
  const decide = (phrase, name, messages = [phrase], price = null) => sel.toConsolidated(output([line({ phrase, product_ref: ref(name), quantity: 1, price_said: price })]), catalog, messages).lines[0]
  assert.equal(decide('un lapicero Faber-Castell azul de un sol', 'Lapicero Trilux Azul-032', undefined, 1).confidence, 'alta', 'el único azul FC de S/ 1')
  assert.equal(decide('un lapicero Faber-Castell azul', 'Lapicero Trilux Azul-032').confidence, 'baja', 'sin precio empata con el 060')
  assert.equal(decide('2 plumones de cartel 123 de pizarra', 'Plumón de Pizarra Acrílico Jumbo - 123').confidence, 'alta', '«de cartel» = Castell')
  assert.equal(decide('dos lapiceros así, azul 0.60', 'Lapicero 060 - Azul, Rojo').confidence, 'alta', '0.60 = 060')
  assert.equal(decide('tres cartulinas a colores', 'Cartulina a colores').confidence, 'alta', 'no agrega nada no dicho; la de pliego A4 sí')
  assert.equal(decide('5 siliconas en barra', 'Silicona en barrra').confidence, 'alta', 'la común, no la delgada')
  // «para pisar» = pizarra contradicts the W47, unless a LATER clarification names it.
  const M1 = 'dos plumones Faber-Castell para pisar'
  assert.equal(decide(M1, 'Plumón de papel delgado  - W47').confidence, 'baja')
  assert.equal(decide(M1, 'Plumón de papel delgado  - W47', [M1, 'En cuanto a los plumones, vamos a vender el W47.']).confidence, 'alta')
  assert.equal(sel.modelCodes('azul 0.60'), 'azul 060')
  assert.equal(sel.modelCodes('cero treinta y dos'), '032')
  assert.equal(sel.modelCodes('mina 0.5'), 'mina 0.5')
})

test('regla del dueño: la cantidad va primero (dígitos o palabras; misma lectura que el registrador, grounding.leadingQuantity)', () => {
  const q = sel.leadingQuantity
  assert.equal(q('Cartulina blanco'), null, 'sin número delante (el modelo pone 1)')
  assert.equal(q('5 papeles a4 arcohiries'), 5)
  assert.equal(q('10 plumons FC 123 Jumbo'), 10)
  assert.equal(q('cinco cartulinas negras'), 5)
  assert.equal(q('una goma en barra, la icona'), 1)
  assert.equal(q('Diez cartulinas negras'), 10)
  assert.equal(q('cuaderno 100 hojas'), null)
  assert.equal(q('plumones FC 123 Jumbo'), null)
  assert.equal(q('media docena de lápices'), 6, 'sin presentación: 6 unidades')
  assert.equal(q('media docena de lápices', 'docena'), 0.5, 'en docenas: media docena')
  // The opening number wins over a quantity the model read from a model code.
  const c = sel.toConsolidated(output([
    line({ phrase: '10 plumons FC 123 Jumbo', product_ref: ref('Plumón de Pizarra Acrílico Jumbo - 123'), quantity: 123 }),
    line({ phrase: 'Cartulina blanco', product_ref: ref('Cartulina blanca'), quantity: null })
  ]), catalog, ['Cartulina blanco. 5 papeles a4 arcohiries, 10 plumons FC 123 Jumbo'])
  assert.deepEqual(c.lines.map(l => l.quantity), [10, 1])
})

test('ejemplo literal del dueño en el set (D11) y en el prompt la regla completa', () => {
  const d11 = golden.cases.find(c => c.id === 'D11')
  assert.equal(d11.messages[0], 'Cartulina blanco. 5 papeles a4 arcohiries, 10 plumons FC 123 Jumbo')
  assert.deepEqual(d11.lines.map(l => [l.product || 'pregunta', l.quantity]), [['Cartulina blanca', 1], ['pregunta', 5], ['Plumón de Pizarra Acrílico Jumbo - 123', 10]])
  // Two Arcoiris papers exist: asking is right; deciding the plain one is accepted until the owner validates.
  assert.deepEqual(d11.lines[1].options, ['Papel Arcoiris', 'Papel Arcoiris  Color Pastel'])
  const system = sel.selectorSystemPrompt(catalog)
  for (const rule of [/la cantidad va SIEMPRE PRIMERO/, /en dígitos o en palabras/, /media docena/, /Sin número delante es 1/, /comas, puntos o «y»/, /pertenece al artículo que viene DESPUÉS/]) assert.match(system, rule)
})

// ------------------------------------------------------------ wiring with process 2 (buildDraft + registrar)

const { makeConsolidatedRegistrar } = await jiti.import('../server/modules/agent/app/registrar.ts')
const { saleConsolidatedSchema } = await jiti.import('../server/modules/agent/contracts.ts')
// Validation catalog from the snapshot (official price = the presentation price).
const validationCatalog = {
  getProduct: async id => { const p = catalog.products.find(x => x.id === id); return p ? { id: p.id, name: p.name, sku: '', brand: p.brand, unit: p.unit, stock: p.stock } : null },
  paymentMethods: async () => catalog.payment_methods,
  customerExists: async () => false,
  quote: async (p, qty, unit) => {
    const row = catalog.products.find(x => x.id === p.id)
    const pres = row.presentations.find(x => x.unit === (unit || row.unit))
    if (!pres || pres.price === null) throw new Error('sin precio')
    return { unit_name: pres.unit, price: pres.price, factor: pres.factor, currency: 'PEN' }
  }
}
const mockModel = out => async () => ({ output: out, usage: { input_tokens: 1, cached_tokens: 0, output_tokens: 1, latency_ms: 1, model: 'mock' } })

test('buildDraft del selector: consolidado con el esquema de contracts.ts; el registrador lo deja como venta DIRECTA (D11 del dueño)', async () => {
  const text = 'Cartulina blanco. 5 papeles a4 arcohiries, 10 plumons FC 123 Jumbo'
  const build = sel.makeSelectorBuildDraft({ catalog: async () => catalog, model: mockModel(output([
    line({ phrase: 'Cartulina blanco', product_ref: ref('Cartulina blanca'), quantity: 1 }),
    line({ phrase: '5 papeles a4 arcohiries', product_ref: ref('Papel Arcoiris'), quantity: 5 }),
    line({ phrase: '10 plumons FC 123 Jumbo', product_ref: ref('Plumón de Pizarra Acrílico Jumbo - 123'), quantity: 123 })
  ])) })
  const consolidated = await build([text], null)
  assert.equal(saleConsolidatedSchema.safeParse(consolidated).success, true)
  assert.deepEqual(consolidated.lines.map(l => l.quantity), [1, 5, 10], 'el 123 es el modelo, la cantidad es la que va primero')
  const decision = await makeConsolidatedRegistrar(validationCatalog)(consolidated, text, new Map())
  assert.equal(decision.kind, 'direct', JSON.stringify(decision.reasons || ''))
  assert.equal(decision.sale.payment_method, 'efectivo')
  assert.equal(decision.sale.total, 0.5 + 5 * 0.1 + 10 * 5)
})

test('buildDraft del selector: una pregunta de catálogo nunca es venta; «cancelar» y lo ajeno no llevan líneas', async () => {
  const answered = []
  const answer = async query => { answered.push(query); return { message: 'Sí, tenemos…', result: { answers: [] } } }
  const ask = sel.makeSelectorBuildDraft({ catalog: async () => catalog, answer, model: mockModel(output([line({ phrase: 'colores faber', product_ref: ref('Caja de Colores Grande x12'), confidence: 'baja' })], { intent: 'pregunta' })) })
  const reply = await ask(['¿tienen colores faber?'], null)
  assert.equal(reply.kind, 'catalog_answer')
  assert.equal(answered[0].items[0].query, 'colores faber')
  const cancel = await sel.makeSelectorBuildDraft({ catalog: async () => catalog, model: mockModel(output([], { intent: 'cancelar' })) })(['cancela todo'], null)
  assert.deepEqual([cancel.version, cancel.intent, cancel.items.length], ['sale-draft/1', 'cancel', 0])
  const other = await sel.makeSelectorBuildDraft({ catalog: async () => catalog, model: mockModel(output([], { intent: 'otro' })) })(['¿cuánto vendimos hoy?'], null)
  assert.equal(other.intent, 'unsupported')
})

test('buildDraft del selector: en una aclaración recibe el consolidado previo (y descarta un borrador legacy)', async () => {
  const seen = []
  const model = async (_s, user) => { seen.push(JSON.parse(user)); return mockModel(output([line({ phrase: 'dos cuadernos marking cuadriculados', product_ref: ref('Cuaderno Markin # 100 h'), quantity: 2 })]))() }
  const build = sel.makeSelectorBuildDraft({ catalog: async () => catalog, model })
  const first = await build(['dos cuadernos marking cuadriculados'], null)
  await build(['dos cuadernos marking cuadriculados', 'con yape'], first)
  await build(['x'], { version: 'sale-draft/1', intent: 'sale', items: [] })
  assert.equal(seen[0].consolidado_previo, null)
  assert.equal(seen[1].consolidado_previo.lines[0].product_id, ref('Cuaderno Markin # 100 h'))
  assert.equal(seen[2].consolidado_previo, null)
})

test('aclaración con otra cantidad: la frase pasa a ser el fragmento que dice esa cantidad (lo exige el registrador)', async () => {
  const D6 = 'Cuadernos de 100 hojas, marca margen cuadriculado.', D6b = 'Dos cuadernos cuadriculados marca marking de 100 hojas.'
  const build = sel.makeSelectorBuildDraft({ catalog: async () => catalog, model: mockModel(output([line({ phrase: D6, product_ref: ref('Cuaderno Markin # 100 h'), quantity: 2 })])) })
  const consolidated = await build([D6, D6b], null)
  assert.equal(consolidated.lines[0].quantity, 2)
  assert.equal(consolidated.lines[0].phrase, 'Dos cuadernos cuadriculados marca marking de 100 hojas')
  const decision = await makeConsolidatedRegistrar(validationCatalog)(consolidated, [D6, D6b].join('\n'), new Map())
  assert.equal(decision.kind, 'direct', JSON.stringify(decision.reasons || ''))
})
