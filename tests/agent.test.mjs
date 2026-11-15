import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// Use the TypeScript loader already supplied by Nuxt, without adding a test runtime.
const requireNuxt = createRequire(import.meta.resolve('nuxt/package.json'))
const { createJiti } = requireNuxt('jiti')
const jiti = createJiti(import.meta.url)
const { makeSalesAgent } = await jiti.import('../server/modules/agent/app/salesAgent.ts')
const { makeDraftValidator } = await jiti.import('../server/modules/agent/app/validateDraft.ts')
const { parseAgentDraft } = await jiti.import('../server/modules/agent/app/proposalAdapter.ts')
const { makeFileAgentStore } = await jiti.import('../server/modules/agent/infra/fileAgentStore.ts')
const { makeSupabaseSaleExecutor, isDefinitiveRpcError } = await jiti.import('../server/modules/agent/infra/supabaseSaleExecutor.ts')
const {
  instructionSchema, saleDraftSchema, AgentConflictError, AgentForbiddenError, SaleNotCommittedError, SaleRejectedByPosError
} = await jiti.import('../server/modules/agent/contracts.ts')

// ---------------------------------------------------------------- fixtures

const CUADERNO = { id: randomUUID(), name: 'Cuaderno A4 100 hojas cuadriculado', sku: 'CUA-1', brand: 'Marca A', unit: 'unidad', stock: 20 }
const LAPICERO = { id: randomUUID(), name: 'Lapicero azul', sku: 'LAP-1', brand: 'Marca L', unit: 'unidad', stock: 50 }
const CLIENTE = randomUUID()

/** Mutable fake of the POS catalog (stock, prices and active products can change between calls). */
const makeCatalog = () => {
  const state = {
    products: new Map([[CUADERNO.id, { ...CUADERNO }], [LAPICERO.id, { ...LAPICERO }]]),
    prices: new Map([[CUADERNO.id, 5], [LAPICERO.id, 1.5]]),
    minStock: new Map([[CUADERNO.id, 0], [LAPICERO.id, 0]]),
    units: { unidad: 1, docena: 12 },
    quotes: 0
  }
  const catalog = {
    getProduct: async id => (state.products.has(id) ? { ...state.products.get(id) } : null),
    paymentMethods: async () => [{ code: 'efectivo', label: 'Efectivo' }, { code: 'yape', label: 'Yape' }],
    customerExists: async id => id === CLIENTE,
    quote: async (product, _qty, unit) => {
      state.quotes++
      const factor = unit ? state.units[unit] : 1
      if (!factor) throw new Error('presentación no existe')
      return { unit_name: unit || product.unit, price: state.prices.get(product.id) * factor, factor, currency: 'PEN' }
    },
    stockLevels: async ids => ids.filter(id => state.products.has(id)).map(id => {
      const p = state.products.get(id)
      return { id, name: p.name, unit: p.unit, stock: p.stock, min_stock: state.minStock.get(id) }
    })
  }
  return { state, catalog }
}

const line = (overrides = {}) => ({
  product_id: CUADERNO.id, candidates: [], quantity: 2, unit: null, price_unit: 5,
  confidence: 'high', doubts: [], query: 'cuaderno A4', ...overrides
})
const draftOf = (overrides = {}) => saleDraftSchema.parse({
  version: 'sale-draft/1', items: [line()], payment_method: 'efectivo', customer_id: null,
  doubts: [], source_text: 'vende 2 cuadernos A4, pago efectivo', ...overrides
})

const instruction = (text = 'vende dos cuadernos, pago efectivo', extra = {}) => ({ protocol: 'yachay-agent/1', type: 'instruction', request_id: randomUUID(), input: { text, locale: 'es-PE' }, ...extra })
const follow = (id, text = 'el de marca A') => instruction(text, { type: 'follow_up', operation_id: id })

const ANA = { id: 'user-ana' }
const BETO = { id: 'user-beto' }

/**
 * Agent with the REAL process 2 (validator + orchestrator + file store) and fakes for agent 1,
 * the catalog and create_sale. `drafts` is the sequence of drafts agent 1 returns.
 */
async function setup(t, { drafts = [draftOf()], ...overrides } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'papeleria-agent-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { state, catalog } = makeCatalog()
  const clock = { now: Date.now() }
  const counts = { build: 0, execute: 0 }
  const sent = []
  const queue = [...drafts]
  const dependencies = {
    store: makeFileAgentStore(dir),
    buildDraft: async () => { counts.build++; return queue.length > 1 ? queue.shift() : queue[0] },
    validate: makeDraftValidator(catalog),
    execute: async (sale, beforeCommit) => {
      await beforeCommit()
      counts.execute++
      sent.push(sale)
      for (const item of sale.items) state.products.get(item.product_id).stock -= item.qty * item.factor
      return { saleId: `sale-${counts.execute}`, total: sale.total }
    },
    stockLevels: catalog.stockLevels,
    now: () => clock.now,
    ...overrides
  }
  const agent = makeSalesAgent(dependencies)
  return { run: (request, seller = ANA) => agent(request, seller), dependencies, counts, sent, state, catalog, clock, dir }
}
const codes = response => response.result.reasons.map(r => r.code)

// ---------------------------------------------------------------- contracts

test('valida protocolo, UUID, límites y vinculación de follow_up', () => {
  assert.equal(instructionSchema.safeParse(instruction()).success, true)
  assert.equal(instructionSchema.safeParse(instruction('', { request_id: 'no-uuid' })).success, false)
  assert.equal(instructionSchema.safeParse(instruction('x'.repeat(2501))).success, false)
  assert.equal(instructionSchema.safeParse(instruction('sí', { type: 'follow_up' })).success, false)
  assert.equal(instructionSchema.safeParse(instruction('vende', { operation_id: randomUUID() })).success, false)
  assert.equal(instructionSchema.safeParse({ ...instruction(), seller_id: randomUUID() }).success, false)
})

test('el contrato sale-draft/1 rechaza campos desconocidos, niveles inválidos y más de 20 líneas', () => {
  assert.equal(saleDraftSchema.safeParse(draftOf()).success, true)
  assert.equal(saleDraftSchema.safeParse({ ...draftOf(), seller_id: 'x' }).success, false)
  assert.equal(saleDraftSchema.safeParse({ ...draftOf(), items: [line({ confidence: 'total' })] }).success, false)
  assert.equal(saleDraftSchema.safeParse({ ...draftOf(), items: Array.from({ length: 21 }, () => line()) }).success, false)
  assert.equal(saleDraftSchema.safeParse({ ...draftOf(), version: 'sale-draft/2' }).success, false)
})

// ---------------------------------------------------------------- process 2: decision rule

test('directo: cada línea segura, precio oficial, stock y forma de pago (también con varias líneas)', async () => {
  const { catalog } = makeCatalog()
  const validate = makeDraftValidator(catalog)
  const one = await validate(draftOf())
  assert.equal(one.kind, 'direct')
  assert.deepEqual(one.sale, {
    customer_id: null, payment_method: 'efectivo', currency: 'PEN', total: 10,
    items: [{ product_id: CUADERNO.id, name: CUADERNO.name, qty: 2, unit_name: 'unidad', price_unit: 5, factor: 1, total: 10 }]
  })
  const two = await validate(draftOf({
    items: [line(), line({ product_id: LAPICERO.id, quantity: 3, price_unit: 1.5, query: 'lapicero azul' })],
    payment_method: 'Yape', customer_id: CLIENTE, source_text: 'vende 2 cuadernos A4 y 3 lapiceros, paga con yape'
  }))
  assert.equal(two.kind, 'direct')
  assert.equal(two.sale.total, 14.5)
  assert.equal(two.sale.payment_method, 'yape') // the label is mapped to the catalog code
  assert.equal(two.sale.customer_id, CLIENTE)
})

test('sin precio en el borrador se usa el oficial; nunca el del borrador', async () => {
  const { catalog } = makeCatalog()
  const result = await makeDraftValidator(catalog)(draftOf({ items: [line({ price_unit: null })] }))
  assert.equal(result.kind, 'direct')
  assert.equal(result.sale.items[0].price_unit, 5)
})

const reviewCases = [
  ['invalid_draft', { items: [] }],
  ['agent_doubt', { doubts: [{ code: 'other', note: '¿100 hojas o 100 cuadernos?' }] }],
  ['agent_doubt', { items: [line({ doubts: [{ code: 'unit_unclear' }] })] }],
  ['low_confidence', { items: [line({ confidence: 'medium' })] }],
  ['product_unresolved', { items: [line({ product_id: null, candidates: [CUADERNO.id, LAPICERO.id], confidence: 'low' })] }],
  ['product_inactive', { items: [line({ product_id: randomUUID() })] }],
  ['missing_quantity', { items: [line({ quantity: null })], source_text: 'vende 2 o 3 cuadernos, efectivo' }],
  ['missing_quantity', { items: [line({ quantity: 0 })] }],
  ['price_unavailable', { items: [line({ unit: 'millar' })], source_text: 'vende 2 millar de cuadernos A4, efectivo' }],
  ['unit_unclear', { items: [line({ unit: 'caja' })] }],
  ['price_changed', { items: [line({ price_unit: 4.5 })] }],
  ['insufficient_stock', { items: [line({ quantity: 21 })] }],
  ['missing_payment', { source_text: 'vende 2 cuadernos A4, una parte con yape y otra en efectivo' }],
  ['invalid_payment', { source_text: 'vende 2 cuadernos A4, pago con plin' }],
  ['invalid_customer', { customer_id: randomUUID() }]
]
for (const [code, overrides] of reviewCases) {
  test(`por confirmar con motivo ${code} (${JSON.stringify(overrides).slice(0, 60)})`, async () => {
    const { catalog } = makeCatalog()
    const result = await makeDraftValidator(catalog)(draftOf(overrides))
    assert.equal(result.kind, 'review')
    assert.ok(result.reasons.some(r => r.code === code), `esperaba ${code}, obtuvo ${result.reasons.map(r => r.code)}`)
    for (const reason of result.reasons) assert.ok(reason.message.length > 5)
  })
}

test('sin forma de pago dicha: efectivo por defecto, venta directa y aviso', async () => {
  const { catalog } = makeCatalog()
  const result = await makeDraftValidator(catalog)(draftOf({ payment_method: null, source_text: 'vende 2 cuadernos A4' }))
  assert.equal(result.kind, 'direct')
  assert.deepEqual([result.sale.payment_method, result.payment_defaulted], ['efectivo', true])
  assert.deepEqual(result.notes, ['Pago: efectivo (por defecto).'])
})

test('precio cambiado: informa ambos precios y registra el oficial en la línea', async () => {
  const { catalog } = makeCatalog()
  const result = await makeDraftValidator(catalog)(draftOf({ items: [line({ price_unit: 4.5 })] }))
  const reason = result.reasons.find(r => r.code === 'price_changed')
  assert.deepEqual(reason.detail, { draft_price: 4.5, official_price: 5 })
  assert.match(reason.message, /S\/ 5\.00 y no S\/ 4\.50/)
  assert.equal(result.items[0].price_unit, 5)
  // Within tolerance (rounding) it is not a change.
  assert.equal((await makeDraftValidator(catalog)(draftOf({ items: [line({ price_unit: 5.001 })] }))).kind, 'direct')
})

test('stock insuficiente: suma líneas repetidas en unidad base, descuenta reservas y reserva solo lo disponible', async () => {
  const { catalog } = makeCatalog()
  const validate = makeDraftValidator(catalog)
  // 1 docena (12) + 10 unidades = 22 > 20
  const result = await validate(draftOf({ items: [line({ quantity: 1, unit: 'docena', price_unit: 60 }), line({ quantity: 10 })], source_text: 'vende una docena de cuadernos y 10 cuadernos sueltos, efectivo' }))
  assert.equal(result.kind, 'review')
  assert.deepEqual(result.reasons.map(r => r.code), ['insufficient_stock'])
  assert.deepEqual(result.reservations, [{ product_id: CUADERNO.id, qty: 20 }])
  // Other pending sales hold 19: only 1 is available, and only 1 is reserved.
  const held = await validate(draftOf(), new Map([[CUADERNO.id, 19]]))
  assert.match(held.reasons[0].message, /hay 1 unidad disponibles \(19 reservadas/)
  assert.deepEqual(held.reservations, [{ product_id: CUADERNO.id, qty: 1 }])
  // Everything reserved by others: no reservation at all.
  assert.deepEqual((await validate(draftOf(), new Map([[CUADERNO.id, 25]]))).reservations, [])
})

test('una línea sin producto no reserva; las resueltas sí', async () => {
  const { catalog } = makeCatalog()
  const result = await makeDraftValidator(catalog)(draftOf({
    items: [line({ product_id: null, candidates: [LAPICERO.id], confidence: 'low', query: 'lapicero azul' }), line({ quantity: 3 })],
    source_text: 'vende 2 lapiceros y 3 cuadernos, efectivo'
  }))
  assert.equal(result.kind, 'review')
  assert.deepEqual(result.reservations, [{ product_id: CUADERNO.id, qty: 3 }])
  assert.deepEqual(result.reasons.map(r => [r.code, r.line]), [['low_confidence', 1], ['product_unresolved', 1]])
})

// ---------------------------------------------------------------- orchestrator: direct + idempotency

test('venta directa a nombre del vendedor; un reintento con el mismo request_id no duplica', async t => {
  const { run, counts, sent } = await setup(t)
  const request = instruction()
  const response = await run(request)
  assert.equal(response.status, 'completed')
  assert.equal(response.result.reference, 'sale-1')
  assert.equal(response.result.total, 10)
  assert.match(response.message, /Venta registrada correctamente \(referencia sale-1\)/)
  assert.equal(sent[0].items[0].price_unit, 5)
  assert.deepEqual(await run(request), response)
  assert.equal(counts.build, 1)
  assert.equal(counts.execute, 1)
})

test('las respuestas sobreviven a recrear el agente (reintento tras reinicio)', async t => {
  const { run, dependencies, counts } = await setup(t)
  const request = instruction()
  const done = await run(request)
  assert.deepEqual(await makeSalesAgent(dependencies)(request, ANA), done)
  assert.equal(counts.execute, 1)
})

test('rechaza reutilizar request_id con contenido distinto', async t => {
  const { run } = await setup(t)
  const request = instruction()
  await run(request)
  await assert.rejects(run({ ...request, input: { text: 'otra venta' } }), AgentConflictError)
})

test('otro vendedor no puede reutilizar el request_id ni continuar la operación', async t => {
  const { run, counts } = await setup(t, { drafts: [draftOf({ items: [line({ confidence: 'medium' })] })] })
  const request = instruction()
  const review = await run(request, ANA)
  assert.equal(review.status, 'pending_review')
  await assert.rejects(run(request, BETO), AgentForbiddenError)
  await assert.rejects(run(follow(review.operation_id), BETO), AgentForbiddenError)
  await assert.rejects(run(follow(review.operation_id, 'cancelar'), BETO), AgentForbiddenError)
  assert.equal((await run(follow(review.operation_id, 'cancelar'), ANA)).status, 'rejected')
  assert.equal(counts.execute, 0)
})

test('un duplicado concurrente devuelve pending y luego recupera el resultado', async t => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  let started
  const ready = new Promise(resolve => { started = resolve })
  const { run, counts } = await setup(t, { buildDraft: async () => { started(); await gate; return draftOf() } })
  const request = instruction()
  const first = run(request)
  await ready
  assert.equal((await run(request)).status, 'pending')
  release()
  assert.equal((await first).status, 'completed')
  assert.equal((await run(request)).status, 'completed')
  assert.equal(counts.execute, 1)
})

// ---------------------------------------------------------------- orchestrator: por confirmar

test('por confirmar: guarda motivos codificados, reserva y no registra', async t => {
  const { run, counts, dependencies } = await setup(t, { drafts: [draftOf({ items: [line({ quantity: 3, confidence: 'medium' })] })] })
  const response = await run(instruction('vende 3 cuadernos, pago efectivo'))
  assert.equal(response.status, 'pending_review')
  assert.equal(response.result.reference, response.operation_id)
  assert.deepEqual(codes(response), ['low_confidence'])
  assert.match(response.message, /Venta por confirmar guardada \(referencia .+\)\. No se registró/)
  assert.match(response.message, /Se reservó el stock/)
  assert.ok(Date.parse(response.result.review_expires_at) > Date.now() + 47 * 3600e3)
  const op = await dependencies.store.getOperation(response.operation_id)
  assert.equal(op.state, 'review')
  assert.deepEqual(op.reservations, [{ product_id: CUADERNO.id, qty: 3 }])
  assert.equal(op.proposal.version, 'sale-draft/1')
  assert.equal(op.reasons[0].code, 'low_confidence')
  assert.equal(counts.execute, 0)
})

test('precio cambiado de punta a punta: queda por confirmar y no se envía a create_sale', async t => {
  const { run, counts } = await setup(t, { drafts: [draftOf({ items: [line({ price_unit: 4 })] })] })
  const response = await run(instruction())
  assert.equal(response.status, 'pending_review')
  assert.deepEqual(codes(response), ['price_changed'])
  assert.equal(counts.execute, 0)
})

test('las reservas descuentan stock para otros vendedores: su venta queda por confirmar por stock', async t => {
  const { run, counts } = await setup(t, {
    drafts: [draftOf({ items: [line({ quantity: 15, confidence: 'medium' })] }), draftOf({ items: [line({ quantity: 6 })] })]
  })
  const first = await run(instruction('vende 15 cuadernos'), ANA)
  assert.equal(first.status, 'pending_review')
  const second = await run(instruction('vende 6 cuadernos, efectivo'), BETO)
  assert.equal(second.status, 'pending_review')
  assert.deepEqual(codes(second), ['insufficient_stock'])
  assert.deepEqual(second.result.reservations, [{ product_id: CUADERNO.id, qty: 5 }])
  assert.equal(counts.execute, 0)
})

test('reserva vencida: deja de contar para otros pedidos y el seguimiento se rechaza', async t => {
  const { run, counts, clock, dependencies } = await setup(t, {
    drafts: [draftOf({ items: [line({ quantity: 20, confidence: 'medium' })] }), draftOf()]
  })
  const review = await run(instruction('vende 20 cuadernos'))
  assert.equal(review.status, 'pending_review')
  clock.now += 48 * 3600e3 + 1
  // The expired reservation no longer blocks: another sale is registered directly.
  const other = await run(instruction('vende dos cuadernos, efectivo'), BETO)
  assert.equal(other.status, 'completed')
  const late = await run(follow(review.operation_id, 'pago efectivo'))
  assert.equal(late.status, 'rejected')
  assert.match(late.message, /venció y se liberó su reserva/)
  const op = await dependencies.store.getOperation(review.operation_id)
  assert.equal(op.state, 'cancelled')
  assert.equal(op.reservations, undefined)
  assert.equal(counts.execute, 1)
})

test('una aclaración completa la venta por confirmar, la registra y libera la reserva', async t => {
  const { run, counts, dependencies } = await setup(t, { drafts: [draftOf({ items: [line({ confidence: 'medium' })] }), draftOf()] })
  const review = await run(instruction('vende dos cuadernos'))
  const completed = await run(follow(review.operation_id, 'pago efectivo'))
  assert.equal(completed.status, 'completed')
  assert.equal(counts.execute, 1)
  const op = await dependencies.store.getOperation(review.operation_id)
  assert.equal(op.reservations, undefined)
  assert.equal(op.state, 'completed')
})

test('el agente 1 recibe el borrador previo en los seguimientos', async t => {
  const seen = []
  const queue = [draftOf({ items: [line({ confidence: 'medium' })] }), draftOf()]
  const { run } = await setup(t, { buildDraft: async (messages, previous) => { seen.push([messages.length, previous ? previous.payment_method : 'none']); return queue.shift() } })
  const review = await run(instruction('vende dos cuadernos'))
  await run(follow(review.operation_id, 'efectivo'))
  assert.deepEqual(seen, [[1, 'none'], [2, 'efectivo']])
})

test('cancelar libera la reserva; un seguimiento desconocido se rechaza', async t => {
  const { run, counts, dependencies } = await setup(t, { drafts: [draftOf({ items: [line({ confidence: 'medium' })] })] })
  assert.equal((await run(follow(randomUUID()))).status, 'rejected')
  const review = await run(instruction())
  const cancelled = await run(follow(review.operation_id, 'cancelar'))
  assert.equal(cancelled.status, 'rejected')
  assert.match(cancelled.message, /liberó/)
  const op = await dependencies.store.getOperation(review.operation_id)
  assert.equal(op.state, 'cancelled')
  assert.equal(op.reservations, undefined)
  assert.equal((await run(follow(review.operation_id))).status, 'rejected')
  assert.equal(counts.execute, 0)
})

test('un borrador fuera de contrato queda por confirmar (invalid_draft) sin reservar ni registrar', async t => {
  const { run, counts } = await setup(t, { drafts: [{ version: 'sale-draft/1', items: 'dos cuadernos' }] })
  const response = await run(instruction())
  assert.equal(response.status, 'pending_review')
  assert.deepEqual(codes(response), ['invalid_draft'])
  assert.deepEqual(response.result.reservations, [])
  assert.equal(counts.execute, 0)
})

test('intención cancelar o no soportada del agente 1 no registra', async t => {
  const cancel = await setup(t, { drafts: [draftOf({ intent: 'cancel', items: [] })] })
  assert.equal((await cancel.run(instruction('mejor no'))).status, 'rejected')
  const other = await setup(t, { drafts: [draftOf({ intent: 'unsupported', items: [] })] })
  assert.match((await other.run(instruction('dame el reporte'))).message, /registra ventas/)
})

test('si falla el agente 1 o el catálogo, se rechaza sin registrar', async t => {
  const a = await setup(t, { buildDraft: async () => { throw new Error('openai caído') } })
  assert.match((await a.run(instruction())).message, /No se pudo interpretar/)
  const b = await setup(t, { validate: async () => { throw new Error('supabase caído') } })
  assert.match((await b.run(instruction())).message, /No se pudo verificar/)
  assert.equal(a.counts.execute + b.counts.execute, 0)
})

// ---------------------------------------------------------------- orchestrator: create_sale outcomes

test('error de transporte tras enviar la venta: indeterminado (pending), nunca éxito ni segunda llamada', async t => {
  let commits = 0
  const { run, dependencies } = await setup(t, { execute: async (_sale, beforeCommit) => { await beforeCommit(); commits++; throw new Error('fetch failed') } })
  const request = instruction()
  const first = await run(request)
  assert.equal(first.status, 'pending')
  assert.equal((await run(request)).status, 'pending')
  assert.equal((await run(follow(first.operation_id))).status, 'pending')
  assert.equal((await dependencies.store.getOperation(first.operation_id)).state, 'executing')
  assert.equal(commits, 1)
})

test('rechazo explícito de create_sale: queda por confirmar (pos_rejected) con reserva de lo disponible', async t => {
  const { run, dependencies } = await setup(t, {
    execute: async (_sale, beforeCommit) => { await beforeCommit(); throw new SaleRejectedByPosError('P0001') }
  })
  const response = await run(instruction())
  assert.equal(response.status, 'pending_review')
  assert.deepEqual(codes(response), ['pos_rejected'])
  assert.match(response.message, /El POS rechazó la venta \(código P0001\)/)
  const op = await dependencies.store.getOperation(response.operation_id)
  assert.equal(op.state, 'review')
  assert.deepEqual(op.reservations, [{ product_id: CUADERNO.id, qty: 2 }])
})

test('un vendedor sin autorización al registrar no envía la venta', async t => {
  const { run, dependencies } = await setup(t, { execute: async () => { throw new SaleNotCommittedError('Tu usuario no tiene un rol de vendedor válido en el POS. No se registró una venta.') } })
  const response = await run(instruction())
  assert.equal(response.status, 'rejected')
  assert.match(response.message, /rol de vendedor válido/)
  assert.equal((await dependencies.store.getOperation(response.operation_id)).state, 'cancelled')
})

test('un fallo de persistencia después del recibo no afirma que la venta falló', async t => {
  const { dependencies, counts } = await setup(t)
  const store = dependencies.store
  dependencies.store = {
    ...store,
    saveOperation: async op => {
      if (op.state === 'completed') throw new Error('disco no disponible')
      return store.saveOperation(op)
    }
  }
  const run = makeSalesAgent(dependencies)
  const request = instruction()
  const result = await run(request, ANA)
  assert.equal(result.status, 'completed')
  assert.equal(result.result.reference, 'sale-1')
  assert.equal((await run(request, ANA)).status, 'pending')
  assert.equal(counts.execute, 1)
})

// ---------------------------------------------------------------- alerts

test('alerta de stock bajo tras registrar, calculada después de la venta', async t => {
  const { run, state } = await setup(t)
  state.minStock.set(CUADERNO.id, 18)
  const response = await run(instruction())
  assert.equal(response.status, 'completed')
  assert.deepEqual(response.result.alerts, [{ product_id: CUADERNO.id, name: CUADERNO.name, unit: 'unidad', available: 18, min_stock: 18, level: 'low' }])
  assert.match(response.message, /Alerta de stock: .*quedan 18 unidad \(mínimo 18\)/)
})

test('la reserva de una venta por confirmar puede dejar el producto agotado y se avisa', async t => {
  const { run } = await setup(t, { drafts: [draftOf({ items: [line({ quantity: 20, confidence: 'medium' })] })] })
  const response = await run(instruction())
  assert.equal(response.status, 'pending_review')
  assert.equal(response.result.alerts[0].level, 'out')
  assert.match(response.message, /agotado/)
})

test('sin alertas cuando el stock está holgado; un fallo de alertas no altera la venta', async t => {
  const ok = await setup(t)
  assert.deepEqual((await ok.run(instruction())).result.alerts, [])
  const failing = await setup(t, { stockLevels: async () => { throw new Error('catálogo caído') } })
  const response = await failing.run(instruction())
  assert.equal(response.status, 'completed')
  assert.deepEqual(response.result.alerts, [])
})

// ---------------------------------------------------------------- executor (create_sale)

test('ejecutor: error con código = no registrada; sin código = indeterminado; guarda antes de llamar', async () => {
  assert.equal(isDefinitiveRpcError({ message: 'Stock insuficiente', code: 'P0001' }), true)
  assert.equal(isDefinitiveRpcError({ message: 'TypeError: fetch failed', code: '' }), false)
  assert.equal(isDefinitiveRpcError({ message: '<html>502</html>' }), false)

  const sale = { customer_id: null, payment_method: 'efectivo', currency: 'PEN', total: 10, items: [{ product_id: CUADERNO.id, name: 'x', qty: 2, unit_name: 'unidad', price_unit: 5, factor: 1, total: 10 }] }
  const order = []
  const rpc = answer => async (token, args) => { order.push(['rpc', token, args.p_items[0].price_unit]); return answer }
  const before = async () => { order.push(['before']) }

  const ok = await makeSupabaseSaleExecutor(async () => 'tok-ana', rpc({ data: 'sale-uuid', error: null }))(sale, before)
  assert.deepEqual(ok, { saleId: 'sale-uuid', total: 10 })
  assert.deepEqual(order, [['before'], ['rpc', 'tok-ana', 5]])

  await assert.rejects(makeSupabaseSaleExecutor(async () => 't', rpc({ data: null, error: { message: 'Stock insuficiente', code: 'P0001' } }))(sale, before), SaleRejectedByPosError)
  await assert.rejects(makeSupabaseSaleExecutor(async () => 't', rpc({ data: null, error: { message: 'fetch failed', code: '' } }))(sale, before),
    error => !(error instanceof SaleRejectedByPosError) && !(error instanceof SaleNotCommittedError))

  order.length = 0
  await assert.rejects(makeSupabaseSaleExecutor(async () => { throw new Error('Sesión revocada.') }, rpc({ data: 'x', error: null }))(sale, before), SaleNotCommittedError)
  assert.deepEqual(order, []) // never dispatched
})

// ---------------------------------------------------------------- SaleProposal (agent 1, hybrid search)

const proposal = (overrides = {}, item = {}) => ({
  confidence: 'high', customer_id: null, payment_method: 'efectivo', total: 10, currency: 'PEN', doubts: [],
  items: [{
    line: 1, query: 'cuaderno A4', product_id: CUADERNO.id, name: CUADERNO.name, sku: 'CUA-1', brand: 'Marca A',
    qty: 2, unit_name: 'unidad', factor: 1, price_unit: 5, total: 10, stock_available: 20, confidence: 'high',
    match_score: 0.97, reasons: ['coinciden hojas, tamaño y marca'], alternatives: [], ...item
  }],
  ...overrides
})

test('SaleProposal segura se convierte a sale-draft/1 y se registra directo; sus motivos de una línea segura no son dudas', async t => {
  const parsed = parseAgentDraft({ proposal: proposal() }, 'vende 2 cuadernos')
  assert.equal(parsed.success, true)
  assert.equal(parsed.data.items[0].quantity, 2)
  assert.deepEqual(parsed.data.items[0].doubts, [])
  const { run, counts } = await setup(t, { drafts: [{ draft: {}, candidates: [], proposal: proposal() }] })
  assert.equal((await run(instruction())).status, 'completed')
  assert.equal(counts.execute, 1)
})

test('SaleProposal media: por confirmar con sus motivos y alternativas como candidatos', async t => {
  const alt = randomUUID()
  const medium = proposal({ confidence: 'medium', doubts: ['Artículo 1: no se indicó el rayado. ' + 'Opciones: '.repeat(60)] }, { confidence: 'medium', reasons: ['100 hojas coincide'], alternatives: [{ product_id: alt, name: 'Otro', sku: 'X', brand: null, score: 0.8 }] })
  const parsed = parseAgentDraft(medium)
  assert.equal(parsed.success, true) // long doubts (> 300 chars) are truncated, not rejected
  assert.deepEqual(parsed.data.items[0].candidates, [alt])
  assert.deepEqual(parsed.data.items[0].doubts, []) // reasons explain the match; they are not doubts
  assert.match(parsed.data.doubts[0].note, /^Artículo 1: no se indicó el rayado/)
  const { run, counts } = await setup(t, { drafts: [medium] })
  const response = await run(instruction())
  assert.equal(response.status, 'pending_review')
  assert.deepEqual(codes(response), ['agent_doubt', 'low_confidence'])
  assert.match(response.message, /no se indicó el rayado/)
  assert.doesNotMatch(response.message, /100 hojas coincide/)
  assert.equal(counts.execute, 0)
})

test('SaleProposal: precio distinto al oficial → por confirmar; sin forma de pago → efectivo por defecto', async t => {
  const { run } = await setup(t, { drafts: [proposal({}, { price_unit: 4 }), proposal({ payment_method: null })] })
  assert.deepEqual(codes(await run(instruction('vende 2 cuadernos A4, efectivo'))), ['price_changed'])
  const cash = await run(instruction('vende 2 cuadernos A4')) // no payment said → efectivo by default
  assert.deepEqual([cash.status, cash.result.payment_method, cash.result.payment_defaulted], ['completed', 'efectivo', true])
})

test('SaleProposal general no segura con líneas seguras y sin dudas no pasa directo', () => {
  const parsed = parseAgentDraft(proposal({ confidence: 'medium' }))
  assert.equal(parsed.data.doubts.length, 1)
})

test('un objeto que no es sale-draft/1 ni SaleProposal no se acepta', () => {
  assert.equal(parseAgentDraft({ foo: 1 }).success, false)
  assert.equal(parseAgentDraft(proposal({ confidence: 'total' })).success, false)
})

// ---------------------------------------------------------------- dry-run (POS_AGENT_DRY_RUN)

const forbiddenExecute = calls => async () => { calls.n++; throw new Error('create_sale NO debe llamarse en dry-run') }

test('dry-run: pedido inequívoco no llama a create_sale, informa would_be completed y nunca responde completed', async t => {
  const calls = { n: 0 }
  const { run, dependencies, state } = await setup(t, { dryRun: true, execute: forbiddenExecute(calls) })
  state.minStock.set(CUADERNO.id, 18)
  const request = instruction()
  const response = await run(request)
  assert.equal(calls.n, 0)
  assert.notEqual(response.status, 'completed')
  assert.equal(response.status, 'rejected')
  assert.equal(response.result.dry_run, true)
  assert.equal(response.result.would_be, 'completed')
  assert.equal(response.result.reference, null)
  assert.equal(response.result.total, 10)
  assert.match(response.message, /^SIMULACIÓN \(dry-run\), NO se registró ninguna venta\. Con datos reales se habría registrado directamente por S\/ 10\.00/)
  // Alerts computed as if the sale had happened (20 − 2 = 18 ≤ min 18), without touching stock.
  assert.equal(response.result.alerts[0].level, 'low')
  assert.equal(state.products.get(CUADERNO.id).stock, 20)
  assert.equal((await dependencies.store.getOperation(response.operation_id)).state, 'simulated')
  // Same idempotency: a retry returns the same simulated answer, still without create_sale.
  assert.deepEqual(await run(request), response)
  await assert.rejects(run({ ...request, input: { text: 'otra' } }), AgentConflictError)
  assert.equal((await run(follow(response.operation_id, 'pago efectivo'))).result.would_be, 'completed')
  assert.equal(calls.n, 0)
})

test('dry-run: por confirmar con motivos y reserva simulada; aclaración, cancelación y vencimiento sin create_sale', async t => {
  const calls = { n: 0 }
  const { run, dependencies, clock } = await setup(t, {
    dryRun: true, execute: forbiddenExecute(calls),
    drafts: [draftOf({ items: [line({ confidence: 'medium' })] }), draftOf(), draftOf({ items: [line({ confidence: 'medium' })] })]
  })
  const review = await run(instruction('vende dos cuadernos'))
  assert.equal(review.status, 'pending_review')
  assert.equal(review.result.dry_run, true)
  assert.equal(review.result.would_be, 'pending_review')
  assert.deepEqual(codes(review), ['low_confidence'])
  assert.match(review.message, /^SIMULACIÓN/)
  assert.deepEqual((await dependencies.store.getOperation(review.operation_id)).reservations, [{ product_id: CUADERNO.id, qty: 2 }])
  const completed = await run(follow(review.operation_id, 'efectivo'))
  assert.equal(completed.result.would_be, 'completed')
  assert.notEqual(completed.status, 'completed')

  const second = await run(instruction('vende dos cuadernos otra vez'))
  assert.equal((await run(follow(second.operation_id, 'cancelar'))).result.dry_run, true)
  const third = await run(instruction('y otros dos'))
  clock.now += 49 * 3600e3
  assert.match((await run(follow(third.operation_id, 'efectivo'))).message, /venció/)
  assert.equal(calls.n, 0)
})

test('dry-run: precio cambiado, stock insuficiente y borrador inválido tampoco llaman a create_sale', async t => {
  const calls = { n: 0 }
  const { run } = await setup(t, {
    dryRun: true, execute: forbiddenExecute(calls),
    drafts: [draftOf({ items: [line({ price_unit: 4 })] }), draftOf({ items: [line({ quantity: 99 })] }), { nada: true }, draftOf()]
  })
  assert.deepEqual(codes(await run(instruction('vende 2 cuadernos, efectivo'))), ['price_changed'])
  assert.deepEqual(codes(await run(instruction('vende 99 cuadernos, efectivo'))), ['insufficient_stock'])
  assert.deepEqual(codes(await run(instruction('c'))), ['invalid_draft'])
  // The simulated reservations of a (2) and b (18) hold the 20 units inside the dry-run store.
  assert.deepEqual(codes(await run(instruction('vende 2 cuadernos, efectivo'))), ['insufficient_stock'])
  assert.equal(calls.n, 0)
})

test('sin dry-run (por defecto o dryRun: false) el comportamiento no cambia: registra y no marca simulación', async t => {
  for (const dryRun of [undefined, false]) {
    const { run, counts } = await setup(t, { dryRun })
    const response = await run(instruction())
    assert.equal(response.status, 'completed')
    assert.equal(response.result.dry_run, undefined)
    assert.equal(response.result.would_be, undefined)
    assert.doesNotMatch(response.message, /SIMULACIÓN/)
    assert.equal(counts.execute, 1)
  }
})

// ---------------------------------------------------------------- catalog questions (agent 1 → CatalogAnswer)

const catalogAnswer = (message = 'Sí, hay Cuaderno A4 Marking: 20 unidades a S/ 5.00.') => ({ kind: 'catalog_answer', message, result: { answers: [{ product_id: CUADERNO.id, stock: 20 }] } })

test('pregunta de catálogo: completed informativo sin referencia, sin venta ni reserva; idempotente', async t => {
  const { run, counts, dependencies } = await setup(t, { drafts: [catalogAnswer()] })
  const request = instruction('¿tenemos cuadernos Marking?')
  const response = await run(request)
  assert.equal(response.status, 'completed')
  assert.equal(response.result.kind, 'catalog_answer')
  assert.equal(response.result.reference, null)
  assert.match(response.message, /Marking/)
  const op = await dependencies.store.getOperation(response.operation_id)
  assert.equal(op.state, 'answered')
  assert.equal(op.reservations, undefined)
  assert.deepEqual(await run(request), response)
  assert.equal((await run(follow(response.operation_id, 'vende 2'))).result.kind, 'catalog_answer') // terminal
  assert.equal(counts.execute, 0)
})

test('pregunta de catálogo dentro de una venta por confirmar no la altera; luego se puede completar', async t => {
  const { run, counts, dependencies } = await setup(t, { drafts: [draftOf({ items: [line({ confidence: 'medium' })] }), catalogAnswer('Quedan 18.'), draftOf()] })
  const review = await run(instruction('vende dos cuadernos'))
  const before = await dependencies.store.getOperation(review.operation_id)
  const answer = await run(follow(review.operation_id, '¿cuántos quedan?'))
  assert.equal(answer.result.kind, 'catalog_answer')
  assert.deepEqual(await dependencies.store.getOperation(review.operation_id), before)
  const done = await run(follow(review.operation_id, 'efectivo'))
  assert.equal(done.status, 'completed')
  assert.equal(done.result.reference, 'sale-1')
  assert.equal(counts.execute, 1)
})

test('pregunta de catálogo en dry-run lleva la marca de simulación; una respuesta vacía no se acepta', async t => {
  const calls = { n: 0 }
  const dry = await setup(t, { dryRun: true, execute: forbiddenExecute(calls), drafts: [catalogAnswer()] })
  const response = await dry.run(instruction('¿tenemos cuadernos?'))
  assert.equal(response.result.dry_run, true)
  assert.equal(response.result.kind, 'catalog_answer')
  assert.equal(calls.n, 0)
  const empty = await setup(t, { drafts: [{ kind: 'catalog_answer', message: '  ', result: {} }] })
  assert.deepEqual(codes(await empty.run(instruction('¿?'))), ['invalid_draft'])
})

// ---------------------------------------------------------------- search is read-only by default

const h3Stub = new URL('./stubs/h3.mjs', import.meta.url).pathname
const jitiStubbed = createJiti(import.meta.url, { alias: { h3: h3Stub } })
const { makeSupabaseAgentCatalog, searchAutoindexIntervalMs } = await jitiStubbed.import('../server/modules/agent/infra/supabaseAgentCatalog.ts')

/** Fake Supabase client: the hybrid RPC exists (migration applied) and every write is recorded. */
const recordingDb = () => {
  const writes = []
  const rows = { product_catalog: [{ id: CUADERNO.id, name: CUADERNO.name, sku: 'CUA-1', brand: 'Marca A', product_type: null }] }
  const query = table => {
    const q = new Proxy({}, {
      get (_, prop) {
        if (prop === 'then') return (ok, fail) => Promise.resolve({ data: rows[table] || [{ product_id: CUADERNO.id }], error: null }).then(ok, fail)
        return (...args) => { if (['update', 'insert', 'upsert', 'delete'].includes(prop)) writes.push([table, prop]); return q }
      }
    })
    return q
  }
  return {
    writes,
    from: query,
    rpc: async name => {
      if (name === 'search_products_hybrid') return { data: [{ product_id: CUADERNO.id, name: CUADERNO.name, sku: 'CUA-1', brand: 'Marca A', category: null, lexical_rank: 1, vector_rank: 1, vector_similarity: 0.9 }], error: null }
      if (name === 'product_search_pending') return { data: [{ product_id: CUADERNO.id, document: 'cuaderno', content_hash: 'h1' }], error: null }
      return { data: null, error: null }
    }
  }
}
const searchWith = async interval => {
  const db = recordingDb()
  const catalog = makeSupabaseAgentCatalog({ db, embed: async texts => texts.map(() => [0.1, 0.2]), embeddingModel: 'text-embedding-3-small', ...(interval === undefined ? {} : { backgroundIndexIntervalMs: interval }) })
  await catalog.searchProducts('cuaderno A4')
  await catalog.searchProducts('cuaderno marca a')
  await new Promise(resolve => setTimeout(resolve, 30)) // background work is fire-and-forget
  return db.writes
}

test('la búsqueda no escribe en la base por defecto, aunque la migración esté aplicada', async () => {
  assert.deepEqual(await searchWith(undefined), [])
  assert.deepEqual(await searchWith(searchAutoindexIntervalMs({ autoindex: false, dryRun: false })), [])
})

test('en dry-run la búsqueda nunca escribe, aunque POS_AGENT_SEARCH_AUTOINDEX esté encendido', async () => {
  assert.equal(searchAutoindexIntervalMs({ autoindex: true, dryRun: true }), Number.POSITIVE_INFINITY)
  assert.deepEqual(await searchWith(searchAutoindexIntervalMs({ autoindex: true, dryRun: true })), [])
})

test('control: solo con POS_AGENT_SEARCH_AUTOINDEX=1 y fuera de dry-run se indexa (el test detecta escrituras)', async () => {
  const writes = await searchWith(searchAutoindexIntervalMs({ autoindex: true, dryRun: false }))
  assert.deepEqual(writes, [['product_search_index', 'update']])
})

// ---------------------------------------------------------------- security review fixes

const { resolveAgentModes, describeAgentModes, memoizeByKey } = await jiti.import('../server/modules/agent/app/runtimeModes.ts')
const { paymentMentioned, quantityGrounded, resolveQuantity: quantityResolver } = await jiti.import('../server/modules/agent/app/grounding.ts')

test('M2: el dry-run se activa en tiempo de ejecución si cualquier fuente lo pide (también en un build de producción)', () => {
  // runtimeConfig baked at build time as false, but the process is launched with the variable:
  assert.equal(resolveAgentModes({ posAgentDryRun: false }, { POS_AGENT_DRY_RUN: '1' }).dryRun, true)
  assert.equal(resolveAgentModes({ posAgentDryRun: false }, { NUXT_POS_AGENT_DRY_RUN: 'true' }).dryRun, true)
  assert.equal(resolveAgentModes({ posAgentDryRun: true }, {}).dryRun, true)
  assert.equal(resolveAgentModes({ posAgentDryRun: 'TRUE' }, {}).dryRun, true)
  assert.equal(resolveAgentModes({ posAgentDryRun: false }, {}).dryRun, false)
  assert.equal(resolveAgentModes({}, { POS_AGENT_DRY_RUN: '0' }).dryRun, false)
  assert.match(describeAgentModes({ dryRun: true, autoindex: false }), /SOLO VALIDACIÓN/)
  assert.match(describeAgentModes({ dryRun: false, autoindex: false }), /REAL: registra ventas.*apagado \(solo lectura\)/)
})

test('M2: el indexado solo se enciende explícitamente y nunca junto con dry-run', () => {
  assert.equal(resolveAgentModes({}, {}).autoindex, false)
  assert.equal(resolveAgentModes({ posAgentSearchAutoindex: false }, { POS_AGENT_SEARCH_AUTOINDEX: '1' }).autoindex, true)
  assert.equal(resolveAgentModes({}, { NUXT_POS_AGENT_SEARCH_AUTOINDEX: '1' }).autoindex, true)
  assert.equal(resolveAgentModes({ posAgentSearchAutoindex: true }, { POS_AGENT_DRY_RUN: '1' }).autoindex, false)
  assert.equal(resolveAgentModes({ posAgentSearchAutoindex: true, posAgentDryRun: true }, {}).autoindex, false)
})

test('M1: la forma de pago debe estar en el texto del vendedor (código, etiqueta o alias)', async () => {
  const efectivo = { code: 'efectivo', label: 'Efectivo' }
  const yape = { code: 'yape', label: 'Yape' }
  assert.equal(paymentMentioned('vende 2 cuadernos', efectivo), false)
  assert.equal(paymentMentioned('vende 2 cuadernos, paga en EFECTIVO', efectivo), true)
  assert.equal(paymentMentioned('2 cuadernos al contado', efectivo), true)
  assert.equal(paymentMentioned('2 cuadernos, yapeo', yape), true)
  assert.equal(paymentMentioned('cuaderno marca efectivoplus', efectivo), false) // whole words only
  const { catalog } = makeCatalog()
  // The AI proposes Yape but the seller said no payment: ignored → efectivo by default.
  const invented = await makeDraftValidator(catalog)(draftOf({ payment_method: 'yape', source_text: 'vende 2 cuadernos A4' }))
  assert.equal(invented.kind, 'direct')
  assert.deepEqual([invented.sale.payment_method, invented.payment_defaulted], ['efectivo', true])
})

test('M1: la cantidad debe estar escrita como cantidad, no tomada de la descripción del producto', async () => {
  assert.equal(quantityGrounded('vende dos cuadernos', 2, 'cuaderno'), true)
  assert.equal(quantityGrounded('vende 2 cuadernos', 2, 'cuaderno'), true)
  assert.equal(quantityGrounded('una docena de lapiceros', 1, 'lapicero'), true)
  assert.equal(quantityGrounded('media docena de lapiceros', 6, 'lapicero'), true)
  assert.equal(quantityGrounded('vende 1,5 metros de papel', 1.5, 'papel'), false) // "1.5 metros" is a measure
  assert.equal(quantityGrounded('vende cuaderno de 100 hojas', 100, 'cuaderno 100 hojas'), false)
  assert.equal(quantityGrounded('regla de 30 cm', 30, 'regla 30 cm'), false)
  assert.equal(quantityGrounded('vende cuaderno a4', 4, 'cuaderno a4'), false)
  assert.equal(quantityGrounded('vende cuaderno a4 100 cuadriculado', 100, 'cuaderno A4 100 cuadriculado'), false)
  assert.equal(quantityGrounded('vende 100 cuadernos a4 100 cuadriculado', 100, 'cuaderno A4 100 cuadriculado'), true)
  assert.equal(quantityGrounded('vende 100 cuadernos de 100 hojas', 100, 'cuaderno 100 hojas'), true)
  const { catalog } = makeCatalog()
  const hojas = await makeDraftValidator(catalog)(draftOf({
    items: [line({ quantity: 100, query: 'cuaderno 100 hojas' })], source_text: 'vende cuaderno de 100 hojas, efectivo'
  }))
  // New rule (cantidad 1 por defecto): the 100 belongs to the description, so the quantity is 1.
  assert.equal(hojas.kind, 'direct')
  assert.equal(hojas.sale.items[0].qty, 1)
  assert.equal(hojas.sale.items[0].quantity_defaulted, true)
})

test('M1: el orquestador ignora el source_text del agente 1 y usa los mensajes reales del vendedor', async t => {
  const { run, counts } = await setup(t, { drafts: [draftOf({ source_text: 'vende 2 cuadernos A4, pago efectivo' })] })
  const response = await run(instruction('vende cuadernos'))
  assert.equal(response.status, 'pending_review')
  assert.deepEqual(codes(response), ['missing_quantity']) // payment: efectivo by default
  assert.equal(counts.execute, 0)
})

test('B2: una sola instancia por proceso mientras la configuración no cambie', () => {
  let built = 0
  const get = memoizeByKey(key => ({ key, n: ++built }))
  const a = get('k1')
  assert.equal(get('k1'), a)
  assert.equal(get('k1'), a)
  assert.equal(built, 1)
  assert.notEqual(get('k2'), a)
  assert.equal(built, 2)
})

const saleForExecutor = { customer_id: null, payment_method: 'efectivo', currency: 'PEN', total: 10, items: [{ product_id: CUADERNO.id, name: 'x', qty: 2, unit_name: 'unidad', price_unit: 5, factor: 1, total: 10 }] }

test('B5: el detalle del error de Postgres va al log del servidor; al chat solo llega el código', async t => {
  const logged = []
  const executor = makeSupabaseSaleExecutor(async () => 't', async () => ({ data: null, error: { code: 'P0001', message: 'Stock insuficiente para Cuaderno Secreto' } }), { log: (m, d) => logged.push(d) })
  await assert.rejects(executor(saleForExecutor, async () => {}), error => error instanceof SaleRejectedByPosError && error.message === 'P0001')
  assert.deepEqual(logged, [{ code: 'P0001', message: 'Stock insuficiente para Cuaderno Secreto' }])
  const { run } = await setup(t, { execute: executor })
  const response = await run(instruction())
  assert.equal(response.status, 'pending_review')
  assert.match(response.message, /código P0001/)
  assert.doesNotMatch(JSON.stringify(response), /Secreto|Stock insuficiente para/)
})

test('B3: si create_sale no responde, el ejecutor corta por timeout y la venta queda indeterminada (pending) sin reintento', async t => {
  let calls = 0
  const hanging = makeSupabaseSaleExecutor(async () => 't', () => { calls++; return new Promise(() => {}) }, { timeoutMs: 20, log: () => {} })
  await assert.rejects(hanging(saleForExecutor, async () => {}), error => !(error instanceof SaleRejectedByPosError) && /timeout/.test(error.message))
  const { run, dependencies } = await setup(t, { execute: makeSupabaseSaleExecutor(async () => 't', () => { calls++; return new Promise(() => {}) }, { timeoutMs: 20, log: () => {} }) })
  const request = instruction()
  const first = await run(request)
  assert.equal(first.status, 'pending')
  assert.equal((await dependencies.store.getOperation(first.operation_id)).state, 'executing')
  assert.equal((await run(request)).status, 'pending') // the lock was released, and no second call
  assert.equal(calls, 2) // one for the direct executor check, one for the orchestrated sale
})

// ---------------------------------------------------------------- supervisor observations

test('O1: una línea ambigua o no encontrada NO reserva el producto propuesto; las demás sí', async () => {
  const { catalog } = makeCatalog()
  const result = await makeDraftValidator(catalog)(draftOf({
    items: [
      line({ product_id: LAPICERO.id, confidence: 'medium', candidates: [randomUUID()], doubts: [{ code: 'ambiguous_product', note: 'Opciones: A; B.' }], price_unit: 1.5, query: 'papel lustre' }),
      line({ quantity: 3 })
    ],
    source_text: 'vende 2 papel lustre y 3 cuadernos, efectivo'
  }))
  assert.equal(result.kind, 'review')
  assert.deepEqual(result.reservations, [{ product_id: CUADERNO.id, qty: 3 }])
  const notFound = await makeDraftValidator(catalog)(draftOf({ items: [line({ confidence: 'low', doubts: [{ code: 'product_not_found' }] })] }))
  assert.deepEqual(notFound.reservations, [])
  // Other doubts (e.g. unit_unclear) still reserve the identified product.
  const unit = await makeDraftValidator(catalog)(draftOf({ items: [line({ confidence: 'medium', doubts: [{ code: 'unit_unclear' }] })] }))
  assert.deepEqual(unit.reservations, [{ product_id: CUADERNO.id, qty: 2 }])
})

test('O1 de punta a punta: «papel lustre» ambiguo queda por confirmar sin reserva ni alerta de agotado por reserva', async t => {
  const { run, dependencies } = await setup(t, {
    drafts: [draftOf({ items: [line({ quantity: 20, confidence: 'medium', candidates: [LAPICERO.id], doubts: [{ code: 'ambiguous_product' }], query: 'papel lustre' })] })]
  })
  const response = await run(instruction('vende 20 papel lustre, efectivo'))
  assert.equal(response.status, 'pending_review')
  assert.deepEqual(response.result.reservations, [])
  assert.doesNotMatch(response.message, /Se reservó/)
  assert.deepEqual(response.result.alerts, [])
  assert.deepEqual((await dependencies.store.getOperation(response.operation_id)).reservations, [])
})

test('O2: result.reasons incluye el código de duda de cada línea (ambiguous_product) y la marca ungrounded', async t => {
  const { run } = await setup(t, {
    drafts: [draftOf({ items: [line({ confidence: 'medium', doubts: [{ code: 'ambiguous_product', note: 'Opciones: A; B.' }] })] })]
  })
  const response = await run(instruction('vende 2 cuadernos'))
  assert.deepEqual(response.result.reasons.map(r => [r.code, r.line ?? null, r.doubt ?? null, r.ungrounded ?? false]), [
    ['agent_doubt', 1, 'ambiguous_product', false],
    ['low_confidence', 1, null, false]
  ])
  // An invented quantity is still flagged as ungrounded.
  const invented = await setup(t, { drafts: [draftOf({ items: [line({ quantity: 3 })] })] })
  const grounded = await invented.run(instruction('vende 2 cuadernos'))
  assert.deepEqual(grounded.result.reasons.map(r => [r.code, r.ungrounded]), [['missing_quantity', true]])
})

test('O3: los mensajes de duda terminan con un solo punto', async () => {
  const { catalog } = makeCatalog()
  const result = await makeDraftValidator(catalog)(draftOf({
    doubts: [{ code: 'other', note: 'Pago con Tarjeta.' }],
    items: [line({ doubts: [{ code: 'unit_unclear', note: '¿Caja o unidad?' }, { code: 'other', note: 'sin punto' }] })]
  }))
  const messages = result.reasons.filter(r => r.code === 'agent_doubt').map(r => r.message)
  assert.deepEqual(messages, ['Duda del pedido: Pago con Tarjeta.', 'Artículo 1 («cuaderno A4»): ¿Caja o unidad?', 'Artículo 1 («cuaderno A4»): sin punto.'])
  for (const message of messages) assert.doesNotMatch(message, /\.\.$/)
})

// ---------------------------------------------------------------- cantidad 1 por defecto y precio dictado

const OWNER = { id: 'user-owner', role: 'owner' }
const MANAGER = { id: 'user-manager', role: 'manager' }
const CAJERO = { id: 'user-caja', role: 'cashier' }
const withCost = (state, cost = 3.5) => { state.products.get(CUADERNO.id).avg_cost = cost }

test('cantidad: si el vendedor no dice cantidad se vende 1 directo y se avisa', async t => {
  const { run, sent } = await setup(t, { drafts: [draftOf({ items: [line({ quantity: null })] })] })
  const response = await run(instruction('vende cuaderno A4, efectivo'))
  assert.equal(response.status, 'completed')
  assert.equal(sent[0].items[0].qty, 1)
  assert.equal(sent[0].items[0].quantity_defaulted, true)
  assert.match(response.message, /no se indicó cantidad, se toma 1 unidad/)
  assert.deepEqual(response.result.notes, [`${CUADERNO.name}: no se indicó cantidad, se toma 1 unidad.`])
})

test('cantidad: la cantidad que sí se dice se respeta y sigue exigiendo grounding', async t => {
  const said = await setup(t, { drafts: [draftOf({ items: [line({ quantity: 3 })] })] })
  const ok = await said.run(instruction('vende tres cuadernos A4, efectivo'))
  assert.equal(ok.status, 'completed')
  assert.equal(said.sent[0].items[0].qty, 3)
  assert.deepEqual(ok.result.notes, [])
  // The AI says 2 but the seller wrote "tres": not grounded and "tres" unclaimed → review.
  const wrong = await setup(t, { drafts: [draftOf({ items: [line({ quantity: 2 })] })] })
  assert.deepEqual(codes(await wrong.run(instruction('vende tres cuadernos A4, efectivo'))), ['missing_quantity'])
  // One-line order and the AI dropped the quantity: it is taken from the seller's text ("tres" → 3).
  const inferred = await setup(t, { drafts: [draftOf({ items: [line({ quantity: null })] })] })
  assert.equal((await inferred.run(instruction('vende tres cuadernos A4, efectivo'))).status, 'completed')
  assert.equal(inferred.sent[0].items[0].qty, 3)
  // Two lines and the AI dropped one quantity: the number written next to that line is used ("tres cuadernos" → 3).
  const perLine = await setup(t, { drafts: [draftOf({ items: [line({ quantity: null }), line({ product_id: LAPICERO.id, quantity: 2, price_unit: 1.5, query: 'lapicero azul' })] })] })
  assert.equal((await perLine.run(instruction('vende tres cuadernos A4 y 2 lapiceros, efectivo'))).status, 'completed')
  assert.deepEqual(perLine.sent[0].items.map(i => i.qty), [3, 2])
  // Two candidate quantities for the same line: review, never a silent 1.
  const dropped = await setup(t, { drafts: [draftOf({ items: [line({ quantity: null }), line({ product_id: LAPICERO.id, quantity: 2, price_unit: 1.5, query: 'lapicero azul' })] })] })
  const response = await dropped.run(instruction('vende tres o cuatro cuadernos A4 y 2 lapiceros, efectivo'))
  assert.deepEqual(codes(response), ['missing_quantity'])
  assert.match(response.message, /no pude asignar/)
  assert.equal(dropped.counts.execute + wrong.counts.execute, 0)
})

test('cantidad: «cuaderno 100 hojas a4» es 1 (el 100 es descripción), aunque el modelo proponga 100', async t => {
  for (const quantity of [null, 100]) {
    const { run, sent } = await setup(t, { drafts: [draftOf({ items: [line({ quantity, query: 'cuaderno 100 hojas a4' })] })] })
    const response = await run(instruction('vende cuaderno 100 hojas a4, efectivo'))
    assert.equal(response.status, 'completed', `quantity ${quantity}`)
    assert.equal(sent[0].items[0].qty, 1)
  }
  // The price "a 3 soles" is never a quantity.
  const { catalog } = makeCatalog()
  const priced = await makeDraftValidator(catalog)(draftOf({ items: [line({ quantity: 3, price_said: null })], source_text: 'vende cuaderno a 3 soles, efectivo' }))
  assert.deepEqual(priced.reasons.map(r => r.code), ['missing_quantity'])
})

test('precio no dictado: se usa el oficial; price_changed sigue igual; un precio inventado por el modelo no cuenta', async t => {
  const official = await setup(t, { drafts: [draftOf({ items: [line({ price_unit: null, price_said: null })] })] })
  assert.equal((await official.run(instruction('vende 2 cuadernos A4, efectivo'), OWNER)).status, 'completed')
  assert.equal(official.sent[0].items[0].price_unit, 5)
  assert.equal(official.sent[0].items[0].manual_reason, undefined)
  const changed = await setup(t, { drafts: [draftOf({ items: [line({ price_unit: 4 })] })] })
  assert.deepEqual(codes(await changed.run(instruction('vende 2 cuadernos A4, efectivo'), OWNER)), ['price_changed'])
  // The model "dictates" S/ 4 but the seller never said it: review (price_unverified), never a silent override.
  const invented = await setup(t, { drafts: [draftOf({ items: [line({ price_said: 4 })] })] })
  const response = await invented.run(instruction('vende 2 cuadernos A4, efectivo'), OWNER)
  assert.deepEqual(codes(response), ['price_unverified'])
  assert.equal(response.result.reasons[0].ungrounded, true)
  assert.equal(invented.counts.execute, 0)
  // A dictated price equal to the list price is just the list price.
  const same = await setup(t, { drafts: [draftOf({ items: [line({ price_said: 5 })] })] })
  assert.equal((await same.run(instruction('vende 2 cuadernos A4 a 5 soles, efectivo'), CAJERO)).status, 'completed')
  assert.equal(same.sent[0].items[0].manual_reason, undefined)
})

test('el ejecutor envía manual_discount_reason a create_sale solo cuando el precio difiere de lista', async () => {
  const seen = []
  const executor = makeSupabaseSaleExecutor(async () => 't', async (_token, args) => { seen.push(args.p_items); return { data: 'sale-1', error: null } }, { log: () => {} })
  await executor({ ...saleForExecutor, items: [{ ...saleForExecutor.items[0], price_unit: 4, list_price: 5, manual_reason: 'Precio dictado por voz (lista S/ 5.00)' }, saleForExecutor.items[0]] }, async () => {})
  assert.deepEqual(seen[0], [
    { product_id: CUADERNO.id, qty: 2, unit_name: 'unidad', price_unit: 4, manual_discount_reason: 'Precio dictado por voz (lista S/ 5.00)' },
    { product_id: CUADERNO.id, qty: 2, unit_name: 'unidad', price_unit: 5 }
  ])
})

test('palabras: «dos cuadernos markin», «tres cintas masking», «una goma en barra», «media docena de lapiceros» = 6, «cuaderno 100 hojas» = 1', async () => {
  const cases = [
    ['dos cuadernos markin 100 hojas cuadriculado, efectivo', 'cuaderno markin 100 hojas cuadriculado', null, 2],
    ['tres cintas masking, efectivo', 'cinta masking', null, 3],
    ['una goma en barra, efectivo', 'goma en barra', null, 1],
    ['media docena de lapiceros, efectivo', 'lapicero', null, 6],
    ['cuaderno 100 hojas, efectivo', 'cuaderno 100 hojas', null, 1],
    // The AI proposes the quantity correctly:
    ['dos cuadernos markin 100 hojas cuadriculado, efectivo', 'cuaderno markin 100 hojas cuadriculado', 2, 2],
    ['tres cintas masking, efectivo', 'cinta masking', 3, 3],
    ['media docena de lapiceros, efectivo', 'lapicero', 6, 6],
    // The AI left the quantity inside the description (what happened in the rehearsal):
    ['dos cuadernos markin 100 hojas cuadriculado, efectivo', 'dos cuadernos markin 100 hojas cuadriculado', 2, 2],
    ['dos cuadernos markin 100 hojas cuadriculado, efectivo', 'dos cuadernos markin 100 hojas cuadriculado', null, 2],
    ['tres cintas masking, efectivo', 'tres cintas masking', 3, 3],
    ['diecisiete sobres manila, efectivo', 'sobre manila', null, 17]
  ]
  for (const [text, query, quantity, expected] of cases) {
    const { catalog } = makeCatalog()
    const result = await makeDraftValidator(catalog)(draftOf({ items: [line({ quantity, query, price_unit: null })], source_text: text }))
    assert.equal(result.kind === 'direct' ? result.sale.items[0].qty : `review:${result.reasons.map(r => r.code)}`, expected, `${text} | ${query} | ${quantity}`)
  }
})

test('palabras: números grandes en español (hasta cien y más) se reconocen como cantidad', () => {
  const { resolveQuantity } = { resolveQuantity: quantityResolver }
  for (const [text, query, expected] of [
    ['veinticinco sobres manila', 'sobre manila', 25], ['treinta y cinco lapiceros', 'lapicero', 35],
    ['cuarenta cuadernos', 'cuaderno', 40], ['cien sobres manila', 'sobre manila', 100], ['quinientos clips', 'clip', 500]
  ]) {
    assert.deepEqual(resolveQuantity(text, expected, query), { ok: true, quantity: expected, defaulted: false }, text)
    assert.equal(resolveQuantity(text, null, query, [], { singleLine: true }).quantity, expected, `${text} (inferida)`)
  }
})

test('palabras: «uno» o un número dentro del nombre del producto no cuenta como cantidad', async () => {
  const { catalog } = makeCatalog()
  // "Pegamento Uno" — the AI proposes 1 or nothing: 1 by default, not a "said" quantity of 1 extra.
  const uno = await makeDraftValidator(catalog)(draftOf({ items: [line({ quantity: null, query: 'pegamento uno', price_unit: null })], source_text: 'vende dos pegamento uno, efectivo' }))
  assert.equal(uno.kind, 'direct')
  assert.equal(uno.sale.items[0].qty, 2)
  // "100 hojas bond" at the start is the product, not the quantity.
  const bond = await makeDraftValidator(catalog)(draftOf({ items: [line({ quantity: null, query: '100 hojas bond', price_unit: null })], source_text: '100 hojas bond, efectivo' }))
  assert.equal(bond.kind, 'direct')
  assert.equal(bond.sale.items[0].qty, 1)
  // "una docena" with the dozen presentation is 1 dozen; without it, 12 units.
  const dozen = await makeDraftValidator(catalog)(draftOf({ items: [line({ quantity: null, unit: 'docena', price_unit: null })], source_text: 'una docena de cuadernos, efectivo' }))
  assert.equal(dozen.sale.items[0].qty, 1)
  const units = await makeDraftValidator(catalog)(draftOf({ items: [line({ quantity: null, price_unit: null })], source_text: 'una docena de cuadernos, efectivo' }))
  assert.equal(units.sale.items[0].qty, 12)
})


// ---------------------------------------------------------------- precio dictado: opción A (por confirmar, el revisor aprueba)

const { listPendingPriceReviews } = await jiti.import('../server/modules/agent/app/priceReview.ts')

test('precio dictado distinto al de lista → por confirmar (price_modified) para owner, manager, cajero y rol sin especificar', async t => {
  for (const seller of [OWNER, MANAGER, CAJERO, ANA]) {
    const { run, counts, dependencies } = await setup(t, { drafts: [draftOf({ items: [line({ price_said: 4 })] })] })
    const response = await run(instruction('vende 2 cuadernos A4 a 4 soles, efectivo'), seller)
    assert.equal(response.status, 'pending_review', String(seller.role))
    assert.deepEqual(codes(response), ['price_modified'])
    assert.match(response.message, /precio dictado S\/ 4\.00 distinto al de lista S\/ 5\.00: queda por confirmar; el revisor la aprueba/)
    assert.equal(counts.execute, 0) // never registered
    const op = await dependencies.store.getOperation(response.operation_id)
    assert.equal(op.state, 'review')
    // The reservation is created, and the dictated and list prices are kept per line for the reviewer.
    assert.deepEqual(op.reservations, [{ product_id: CUADERNO.id, qty: 2 }])
    assert.deepEqual([response.result.items[0].price_unit, response.result.items[0].list_price, response.result.items[0].manual_reason], [4, 5, 'Precio dictado por vendedor (lista S/ 5.00)'])
    assert.equal(response.result.price_review, 'pending')
  }
})

test('precio dictado igual al de lista → venta directa (sin revisión); sin precio dictado → igual que antes', async t => {
  const same = await setup(t, { drafts: [draftOf({ items: [line({ price_said: 5 })] })] })
  const response = await same.run(instruction('vende 2 cuadernos A4 a 5 soles, efectivo'), CAJERO)
  assert.equal(response.status, 'completed')
  assert.equal(same.sent[0].items[0].price_unit, 5)
  assert.equal(same.sent[0].items[0].manual_reason, undefined)
  assert.equal(response.result.price_review, undefined)
  const none = await setup(t)
  assert.equal((await none.run(instruction('vende 2 cuadernos A4, efectivo'), OWNER)).status, 'completed')
  assert.deepEqual(await listPendingPriceReviews(none.dependencies.store), [])
})

test('precio dictado como total («2 por 9 soles») = 4.50 c/u, por confirmar', async t => {
  const { run } = await setup(t, { drafts: [draftOf({ items: [line({ price_said: 4.5 })] })] })
  const response = await run(instruction('vende 2 cuadernos A4 por 9 soles, efectivo'), OWNER)
  assert.deepEqual(codes(response), ['price_modified'])
  assert.equal(response.result.items[0].price_unit, 4.5)
})

test('precio dictado bajo el costo: por confirmar + alerta; el costo solo lo ve owner/manager', async t => {
  const owner = await setup(t, { drafts: [draftOf({ items: [line({ price_said: 3 })] })] })
  withCost(owner.state, 3.5)
  const forOwner = await owner.run(instruction('vende 2 cuadernos A4 a 3 soles, efectivo'), OWNER)
  assert.deepEqual(codes(forOwner), ['price_modified'])
  assert.deepEqual(forOwner.result.price_alerts, [{ product_id: CUADERNO.id, name: CUADERNO.name, price_unit: 3, unit_cost: 3.5, level: 'below_cost' }])
  assert.match(forOwner.message, /bajo su costo S\/ 3\.50/)
  const cashier = await setup(t, { drafts: [draftOf({ items: [line({ price_said: 3 })] })] })
  withCost(cashier.state, 3.5)
  const forCashier = await cashier.run(instruction('vende 2 cuadernos A4 a 3 soles, efectivo'), CAJERO)
  assert.deepEqual(codes(forCashier), ['price_modified'])
  assert.deepEqual(forCashier.result.price_alerts, [{ product_id: CUADERNO.id, name: CUADERNO.name, price_unit: 3, level: 'below_cost' }])
  assert.match(forCashier.message, /Alerta: precio bajo para .* \(S\/ 3\.00\)/)
  assert.doesNotMatch(JSON.stringify(forCashier), /3\.5|costo/)
  // Cost of the presentation = avg cost × factor (docena: 12 × 3.5 = 42), owner view.
  const { catalog, state } = makeCatalog()
  withCost(state, 3.5)
  const dozen = await makeDraftValidator(catalog)(draftOf({ items: [line({ quantity: 1, unit: 'docena', price_unit: 60, price_said: 40 })], source_text: 'una docena de cuadernos a 40 soles, efectivo' }), new Map(), { role: 'owner' })
  assert.equal(dozen.price_alerts[0].unit_cost, 42)
})

test('revisión de precios: lista las ventas POR CONFIRMAR con precio modificado (no registradas) y deja de listarlas al vencer', async t => {
  const { run, dependencies, clock, counts } = await setup(t, { drafts: [draftOf({ items: [line({ price_said: 4 })] })] })
  const response = await run(instruction('vende 2 cuadernos A4 a 4 soles, efectivo'), CAJERO)
  const reviews = await listPendingPriceReviews(dependencies.store, clock.now)
  assert.equal(reviews.length, 1)
  assert.deepEqual({ ...reviews[0], created_at: 'x', expires_at: 'y' }, {
    status: 'pending', sale_reference: null, seller_id: CAJERO.id, created_at: 'x', expires_at: 'y', operation_id: response.operation_id,
    items: [{ product_id: CUADERNO.id, name: CUADERNO.name, qty: 2, unit_name: 'unidad', list_price: 5, price_unit: 4, below_cost: false }]
  })
  assert.equal(counts.execute, 0)
  // 48 h later the reservation is released and it leaves the list; the operation file is kept (audit).
  clock.now += 48 * 3600e3 + 1
  assert.deepEqual(await listPendingPriceReviews(dependencies.store, clock.now), [])
  const op = await dependencies.store.getOperation(response.operation_id)
  assert.deepEqual([op.price_review.items[0].price_unit, op.proposal.items[0].price_said], [4, 4])
})

test('si el vendedor retira el precio dictado en una aclaración, la venta se registra a precio de lista y sale de la revisión', async t => {
  const { run, dependencies, sent } = await setup(t, { drafts: [draftOf({ items: [line({ price_said: 4 })] }), draftOf()] })
  const review = await run(instruction('vende 2 cuadernos A4 a 4 soles, efectivo'), CAJERO)
  const done = await run(follow(review.operation_id, 'mejor a precio de lista, 2 cuadernos, efectivo'), CAJERO)
  assert.equal(done.status, 'completed')
  assert.equal(sent[0].items[0].price_unit, 5)
  assert.equal((await dependencies.store.getOperation(review.operation_id)).price_review, undefined)
  assert.deepEqual(await listPendingPriceReviews(dependencies.store), [])
})

test('dry-run con precio dictado distinto y cantidad por defecto: would_be pending_review, sin create_sale', async t => {
  const calls = { n: 0 }
  const { run } = await setup(t, { dryRun: true, execute: forbiddenExecute(calls), drafts: [draftOf({ items: [line({ quantity: null, price_said: 4 })] })] })
  const response = await run(instruction('vende cuaderno A4 a 4 soles, efectivo'), OWNER)
  assert.equal(response.result.would_be, 'pending_review')
  assert.deepEqual(codes(response), ['price_modified'])
  assert.equal(response.result.items[0].qty, 1)
  assert.equal(calls.n, 0)
})

test('el dictado «$1» se lee como un sol: es precio, no cantidad', async () => {
  const { moneyMentions } = await jiti.import('../server/modules/agent/app/grounding.ts')
  assert.deepEqual(moneyMentions('Un lápiz de $1. Vender.'), [1])
  assert.deepEqual(moneyMentions('dos cuadernos a $4.50'), [4.5])
  assert.equal(quantityResolver('dos cuadernos a $4.50', null, 'cuaderno', [], { singleLine: true }).quantity, 2)
  const { catalog } = makeCatalog()
  const result = await makeDraftValidator(catalog)(draftOf({ items: [line({ quantity: null, price_said: 4 })], source_text: 'dos cuadernos a $4, efectivo' }), new Map(), { role: 'owner' })
  assert.deepEqual(result.reasons.map(r => r.code), ['price_modified']) // grounded: "$4" counts as a dictated price
  assert.deepEqual([result.items[0].qty, result.items[0].price_unit], [2, 4])
})

// ---------------------------------------------------------------- revisión independiente: sonda del supervisor

const LAP = { id: '11111111-1111-1111-1111-111111111111', name: 'Lapicero azul', sku: 'LAP1', brand: null, unit: 'unidad', stock: 1000, avg_cost: 0.5 }
const CUA = { id: '22222222-2222-2222-2222-222222222222', name: 'Cuaderno A4', sku: 'CU1', brand: null, unit: 'unidad', stock: 1000, avg_cost: 3 }
const probeCatalog = (lapUnitPrice = 1) => {
  const prices = { [LAP.id]: { unidad: [lapUnitPrice, 1], docena: [10, 12], caja: [40, 50] }, [CUA.id]: { unidad: [5, 1], docena: [55, 12] } }
  return {
    getProduct: async id => [LAP, CUA].find(p => p.id === id) || null,
    paymentMethods: async () => [{ code: 'efectivo', label: 'Efectivo' }, { code: 'yape', label: 'Yape' }],
    customerExists: async () => true,
    quote: async (p, _qty, unit) => { const u = unit || p.unit; const r = prices[p.id][u]; if (!r) throw new Error('x'); return { unit_name: u, price: r[0], factor: r[1], currency: 'PEN' } }
  }
}
const pl = o => ({ product_id: LAP.id, candidates: [], quantity: null, unit: null, price_unit: null, price_said: null, confidence: 'high', doubts: [], query: 'lapicero azul', ...o })
const pd = (items, text, pay = 'efectivo') => saleDraftSchema.parse({ version: 'sale-draft/1', intent: 'sale', items, payment_method: pay, customer_id: null, doubts: [], source_text: text })
const probe = async (draft, lapUnitPrice) => makeDraftValidator(probeCatalog(lapUnitPrice))(draft)

const probeCases = [
  ['A presentación inventada (caja)', pd([pl({ quantity: 2, unit: 'caja' })], '2 lapiceros azules, efectivo'), 'unit_unclear'],
  ['B «una docena» → 12 docenas', pd([pl({ quantity: 12, unit: 'docena' })], 'una docena de lapiceros azules, efectivo'), 'missing_quantity'],
  ['C «media docena» → 6 docenas', pd([pl({ quantity: 6, unit: 'docena' })], 'media docena de lapiceros azules, efectivo'), 'missing_quantity'],
  ['D «media docena» → 0.5 unidad', pd([pl({ quantity: 0.5 })], 'media docena de lapiceros azules, efectivo'), 'missing_quantity'],
  ['E cantidades intercambiadas', pd([pl({ quantity: 3 }), pl({ product_id: CUA.id, quantity: 2, query: 'cuaderno a4' })], '2 lapiceros azules y 3 cuadernos a4, efectivo'), 'missing_quantity'],
  ['F precios cruzados', pd([pl({ quantity: 1, price_said: 5 }), pl({ product_id: CUA.id, quantity: 1, price_said: 1, query: 'cuaderno a4' })], 'un lapicero azul a 1 sol y un cuaderno a4 a 5 soles, efectivo'), 'price_unverified'],
  ['G cantidad tomada del pago', pd([pl({ quantity: 50 })], 'lapicero azul, pagó con 50, efectivo'), 'missing_quantity'],
  ['H cantidad 1 de otra línea', pd([pl({ quantity: 1 }), pl({ product_id: CUA.id, quantity: 3, query: 'cuaderno a4' })], 'un cuaderno a4 y 3 lapiceros azules, efectivo'), 'missing_quantity'],
  ['J precio oficial 0', pd([pl({ quantity: 1 })], 'un lapicero azul, efectivo'), 'price_unavailable', 0]
]
for (const [name, draft, code, lapPrice] of probeCases) {
  test(`sonda ${name} → revisión (${code}), nunca directa`, async () => {
    const result = await probe(draft, lapPrice)
    assert.equal(result.kind, 'review')
    assert.ok(result.reasons.some(r => r.code === code), result.reasons.map(r => r.code).join(','))
  })
}

const probeCorrect = [
  ['2 cajas dichas', pd([pl({ quantity: 2, unit: 'caja' })], '2 cajas de lapiceros azules, efectivo'), [[2, 'caja']]],
  ['una docena = 1 docena', pd([pl({ quantity: 1, unit: 'docena' })], 'una docena de lapiceros azules, efectivo'), [[1, 'docena']]],
  ['una docena = 12 unidades', pd([pl({ quantity: 12 })], 'una docena de lapiceros azules, efectivo'), [[12, 'unidad']]],
  ['media docena = 0.5 docena', pd([pl({ quantity: 0.5, unit: 'docena' })], 'media docena de lapiceros azules, efectivo'), [[0.5, 'docena']]],
  ['media docena = 6 unidades', pd([pl({ quantity: 6 })], 'media docena de lapiceros azules, efectivo'), [[6, 'unidad']]],
  ['cantidades en su línea', pd([pl({ quantity: 2 }), pl({ product_id: CUA.id, quantity: 3, query: 'cuaderno a4' })], '2 lapiceros azules y 3 cuadernos a4, efectivo'), [[2, 'unidad'], [3, 'unidad']]],
  ['la IA pierde una cantidad (varias líneas)', pd([pl({ quantity: null }), pl({ product_id: CUA.id, quantity: 3, query: 'cuaderno a4' })], '2 lapiceros azules y 3 cuadernos a4, efectivo'), [[2, 'unidad'], [3, 'unidad']]],
  ['«un cuaderno y 3 lapiceros»', pd([pl({ quantity: 3 }), pl({ product_id: CUA.id, quantity: 1, query: 'cuaderno a4' })], 'un cuaderno a4 y 3 lapiceros azules, efectivo'), [[3, 'unidad'], [1, 'unidad']]],
  ['«pagó con 50» sin cantidad → 1', pd([pl({ quantity: null })], 'lapicero azul, pagó con 50, efectivo'), [[1, 'unidad']]],
  ['«yape no, efectivo» con efectivo', pd([pl({ quantity: 1 })], 'un lapicero azul, yape no, efectivo'), [[1, 'unidad']]]
]
for (const [name, draft, expected] of probeCorrect) {
  test(`sonda (correcto) ${name} → directa`, async () => {
    const result = await probe(draft)
    assert.equal(result.kind, 'direct', result.kind === 'review' ? result.reasons.map(r => r.code).join(',') : '')
    assert.deepEqual(result.sale.items.map(i => [i.qty, i.unit_name]), expected)
  })
}

test('precios dictados en su línea: cada monto va con el producto que lo precede', async () => {
  const result = await probe(pd([pl({ quantity: 1, price_said: 1.5 }), pl({ product_id: CUA.id, quantity: 1, price_said: 4, query: 'cuaderno a4' })], 'un lapicero azul a 1.50 soles y un cuaderno a4 a 4 soles, efectivo'))
  assert.deepEqual(result.reasons.map(r => r.code), ['price_modified', 'price_modified']) // grounded per line (option A: review)
  assert.deepEqual(result.items.map(i => i.price_unit), [1.5, 4])
})

test('«paga con 20», «vuelto de 5», «billete de 100» son montos, no cantidades', async () => {
  for (const text of ['lapicero azul, paga con 20, efectivo', 'lapicero azul, vuelto de 5, efectivo', 'lapicero azul con billete de 100, efectivo']) {
    const result = await probe(pd([pl({ quantity: null })], text))
    assert.equal(result.kind, 'direct', text)
    assert.equal(result.sale.items[0].qty, 1, text)
  }
})

test('pago negado: «sin tarjeta», «no con yape», «yape no» no respaldan ese pago', () => {
  const yape = { code: 'yape', label: 'Yape' }
  for (const text of ['no es yape, efectivo', 'no con yape', 'yape no, efectivo', 'sin yape']) assert.equal(paymentMentioned(text, yape), false, text)
  for (const text of ['paga con yape', 'efectivo no, yape', 'yape']) assert.equal(paymentMentioned(text, yape), true, text)
})

test('una cantidad no entera en una presentación por unidad va a revisión', async () => {
  const result = await probe(pd([pl({ quantity: 1.5 })], '1.5 lapiceros azules, efectivo'))
  assert.equal(result.kind, 'review')
  assert.ok(result.reasons.some(r => r.code === 'missing_quantity'))
})

// ---------------------------------------------------------------- «no» suelto y lock

test('un «no» suelto ya no anula la venta por confirmar; «cancelar» sí', async t => {
  const { run, dependencies } = await setup(t, { drafts: [draftOf({ items: [line({ confidence: 'medium' })] })] })
  const review = await run(instruction('vende dos cuadernos A4'))
  const answer = await run(follow(review.operation_id, 'no'))
  assert.equal(answer.status, 'pending_review')
  assert.equal((await dependencies.store.getOperation(review.operation_id)).state, 'review')
  assert.equal((await run(follow(review.operation_id, 'cancelar'))).status, 'rejected')
})

test('el agente 1 corre FUERA del lock: mientras prepara un pedido, otro vendedor no queda en pending', async t => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  let started
  const ready = new Promise(resolve => { started = resolve })
  let calls = 0
  const { run, counts } = await setup(t, { buildDraft: async () => { if (++calls === 1) { started(); await gate } return draftOf() } })
  const slow = run(instruction('vende dos cuadernos A4, efectivo'), ANA)
  await ready
  const other = await run(instruction('vende dos cuadernos A4, pago efectivo'), BETO)
  assert.equal(other.status, 'completed') // not blocked by Ana's draft being built
  release()
  assert.equal((await slow).status, 'completed')
  assert.equal(counts.execute, 2)
})

test('un pedido reclamado e interrumpido (sin ejecución) responde rejected, no pending eterno; un indeterminado sigue pending', async t => {
  const { run, dependencies, clock, counts } = await setup(t)
  const request = instruction()
  // A crashed process left the claim: request without response, operation preparing.
  await dependencies.store.saveRequest(request.request_id, {
    fingerprint: (await import('node:crypto')).createHash('sha256').update(JSON.stringify([request.protocol, request.type, null, request.input.text, 'es-PE', ANA.id])).digest('hex'),
    operation_id: request.request_id, seller_id: ANA.id, claimed_at: clock.now
  })
  await dependencies.store.saveOperation({ id: request.request_id, state: 'preparing', seller_id: ANA.id, messages: [], expires_at: clock.now + 1e9, inflight: { request_id: request.request_id, started_at: clock.now } })
  assert.equal((await run(request)).status, 'pending') // still fresh: maybe being prepared
  clock.now += 121_000
  const late = await run(request)
  assert.equal(late.status, 'rejected')
  assert.match(late.message, /se interrumpió el proceso\. No se registró una venta/)
  assert.deepEqual(await run(request), late) // stable answer
  assert.equal(counts.execute, 0)
  // If create_sale was dispatched (executing), it stays pending and is never retried.
  const lost = await setup(t, { execute: async (_s, beforeCommit) => { await beforeCommit(); throw new Error('fetch failed') } })
  const sent = instruction()
  assert.equal((await lost.run(sent)).status, 'pending')
  lost.clock.now += 10 * 60_000
  assert.equal((await lost.run(sent)).status, 'pending')
})

test('lock huérfano: se recupera si su proceso murió y no hay create_sale sin cerrar; si lo hay, sigue ocupado', async t => {
  const { writeFile } = await import('node:fs/promises')
  const { spawnSync } = await import('node:child_process')
  const deadPid = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout.toString() * 1
  const { run, dependencies, dir } = await setup(t)
  await writeFile(join(dir, 'processing.lock'), JSON.stringify({ pid: deadPid, started_at: new Date().toISOString() }))
  assert.equal((await run(instruction())).status, 'completed') // recovered
  // An unsettled dispatch blocks the recovery (a person must reconcile it).
  await dependencies.store.saveOperation({ id: randomUUID(), state: 'executing', seller_id: ANA.id, messages: [], expires_at: 0, execution: { request_id: randomUUID(), started_at: 0, settled: false } })
  await writeFile(join(dir, 'processing.lock'), JSON.stringify({ pid: deadPid, started_at: new Date().toISOString() }))
  assert.equal((await run(instruction('vende dos cuadernos A4, pago efectivo'))).status, 'pending')
  // A lock held by a live process is never taken over.
  await writeFile(join(dir, 'processing.lock'), JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }))
  assert.equal((await run(instruction('vende dos cuadernos A4, efectivo ya'))).status, 'pending')
})

// ---------------------------------------------------------------- forma de pago: efectivo por defecto

const payWith = async (text, aiPayment = null) => makeDraftValidator(makeCatalog().catalog)(draftOf({ payment_method: aiPayment, source_text: text }))

test('pago: sin pago dicho → efectivo directo (payment_defaulted); la respuesta lo indica', async t => {
  const result = await payWith('vende 2 cuadernos A4')
  assert.deepEqual([result.kind, result.sale.payment_method, result.payment_defaulted], ['direct', 'efectivo', true])
  const { run, sent } = await setup(t, { drafts: [draftOf({ payment_method: null })] })
  const response = await run(instruction('vende 2 cuadernos A4'))
  assert.equal(response.status, 'completed')
  assert.equal(sent[0].payment_method, 'efectivo')
  assert.equal(response.result.payment_defaulted, true)
  assert.match(response.message, /Pago: efectivo \(por defecto\)\./)
})

test('pago: el que dice el vendedor (yape) se registra; «efectivo» dicho no es «por defecto»', async () => {
  const yape = await payWith('vende 2 cuadernos A4, pago por yape', 'yape')
  assert.deepEqual([yape.kind, yape.sale.payment_method, yape.payment_defaulted], ['direct', 'yape', false])
  const dropped = await payWith('vende 2 cuadernos A4, yapeo') // the AI dropped it: the text decides
  assert.equal(dropped.sale.payment_method, 'yape')
  const cash = await payWith('vende 2 cuadernos A4, efectivo', 'efectivo')
  assert.deepEqual([cash.sale.payment_method, cash.payment_defaulted], ['efectivo', false])
})

test('pago: «por transferencia» → transferencia', async () => {
  const methods = [{ code: 'efectivo', label: 'Efectivo' }, { code: 'transferencia', label: 'Transferencia bancaria' }]
  const catalog = { ...makeCatalog().catalog, paymentMethods: async () => methods }
  const result = await makeDraftValidator(catalog)(draftOf({ payment_method: 'transferencia', source_text: 'vende 2 cuadernos A4, pago por transferencia' }))
  assert.deepEqual([result.kind, result.sale.payment_method, result.payment_defaulted], ['direct', 'transferencia', false])
})

test('pago: «yape no, efectivo» → efectivo; «no es yape, efectivo» con la IA en yape → efectivo, nunca yape', async () => {
  for (const [text, ai] of [['vende 2 cuadernos A4, yape no, efectivo', 'yape'], ['vende 2 cuadernos A4, no es yape, efectivo', 'yape']]) {
    const result = await payWith(text, ai)
    assert.deepEqual([result.kind, result.sale.payment_method], ['direct', 'efectivo'], text)
  }
  // Only negated: nothing said → efectivo by default.
  const negated = await payWith('vende 2 cuadernos A4, no es yape', 'yape')
  assert.deepEqual([negated.sale.payment_method, negated.payment_defaulted], ['efectivo', true])
})

test('pago: la IA propone yape que el vendedor no dijo → efectivo (nunca registra yape)', async t => {
  const { run, sent } = await setup(t, { drafts: [draftOf({ payment_method: 'yape' })] })
  const response = await run(instruction('vende 2 cuadernos A4'))
  assert.equal(response.status, 'completed')
  assert.equal(sent[0].payment_method, 'efectivo')
  assert.equal(response.result.payment_defaulted, true)
})

test('pago: uno dicho que no está disponible, o varios distintos → por confirmar', async () => {
  const plin = await payWith('vende 2 cuadernos A4, pago con plin', 'plin')
  assert.deepEqual([plin.kind, plin.reasons.map(r => r.code)], ['review', ['invalid_payment']])
  const both = await payWith('vende 2 cuadernos A4, mitad yape y mitad efectivo', 'yape')
  assert.deepEqual([both.kind, both.reasons.map(r => r.code)], ['review', ['missing_payment']])
  // agent 1's «falta la forma de pago» doubt is not a reason to review anymore.
  const doubt = await makeDraftValidator(makeCatalog().catalog)(draftOf({ payment_method: null, doubts: [{ code: 'missing_payment' }], source_text: 'vende 2 cuadernos A4' }))
  assert.equal(doubt.kind, 'direct')
})
