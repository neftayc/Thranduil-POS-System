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
const { makeLegacyDraftBuilder } = await jiti.import('../server/modules/agent/app/legacyDraftBuilder.ts')
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
  confidence: 'high', doubts: [], query: '2 cuadernos A4', ...overrides
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
  return { run: (request, seller = ANA) => agent(request, seller), dependencies, counts, sent, state, catalog, clock }
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
    items: [line(), line({ product_id: LAPICERO.id, quantity: 3, price_unit: 1.5, query: '3 lapiceros' })],
    payment_method: 'Yape', customer_id: CLIENTE
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
  ['missing_quantity', { items: [line({ quantity: null })] }],
  ['missing_quantity', { items: [line({ quantity: 0 })] }],
  ['price_unavailable', { items: [line({ unit: 'millar' })] }],
  ['price_changed', { items: [line({ price_unit: 4.5 })] }],
  ['insufficient_stock', { items: [line({ quantity: 21 })] }],
  ['missing_payment', { payment_method: null }],
  ['invalid_payment', { payment_method: 'trueque' }],
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

test('solo falta la forma de pago: por confirmar con el stock reservado (no se asume efectivo)', async () => {
  const { catalog } = makeCatalog()
  const result = await makeDraftValidator(catalog)(draftOf({ payment_method: null }))
  assert.equal(result.kind, 'review')
  assert.deepEqual(result.reasons.map(r => r.code), ['missing_payment'])
  assert.deepEqual(result.reservations, [{ product_id: CUADERNO.id, qty: 2 }])
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
  const result = await validate(draftOf({ items: [line({ quantity: 1, unit: 'docena', price_unit: 60 }), line({ quantity: 10 })] }))
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
    items: [line({ product_id: null, candidates: [LAPICERO.id], confidence: 'low' }), line({ quantity: 3 })]
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
  const { run, counts } = await setup(t, { drafts: [draftOf({ payment_method: null })] })
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
  const response = await run(instruction())
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
    drafts: [draftOf({ items: [line({ quantity: 15 })], payment_method: null }), draftOf({ items: [line({ quantity: 6 })] })]
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
    drafts: [draftOf({ items: [line({ quantity: 20 })], payment_method: null }), draftOf()]
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
  const { run, counts, dependencies } = await setup(t, { drafts: [draftOf({ payment_method: null }), draftOf()] })
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
  const queue = [draftOf({ payment_method: null }), draftOf()]
  const { run } = await setup(t, { buildDraft: async (messages, previous) => { seen.push([messages.length, previous ? previous.payment_method : 'none']); return queue.shift() } })
  const review = await run(instruction('vende dos cuadernos'))
  await run(follow(review.operation_id, 'efectivo'))
  assert.deepEqual(seen, [[1, 'none'], [2, null]])
})

test('cancelar libera la reserva; un seguimiento desconocido se rechaza', async t => {
  const { run, counts, dependencies } = await setup(t, { drafts: [draftOf({ payment_method: null })] })
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
    execute: async (_sale, beforeCommit) => { await beforeCommit(); throw new SaleRejectedByPosError('Stock insuficiente para Cuaderno') }
  })
  const response = await run(instruction())
  assert.equal(response.status, 'pending_review')
  assert.deepEqual(codes(response), ['pos_rejected'])
  assert.match(response.message, /El POS rechazó la venta: Stock insuficiente/)
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
  const { run } = await setup(t, { drafts: [draftOf({ items: [line({ quantity: 20 })], payment_method: null })] })
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

// ---------------------------------------------------------------- provisional agent 1

test('constructor provisional: coincidencia única = segura; varias = candidatos y duda; elección posterior válida', async () => {
  const second = { ...CUADERNO, id: randomUUID(), sku: 'CUA-2', brand: 'Marca B' }
  const search = {
    findProducts: async query => (query.includes('marca a') ? [CUADERNO] : [CUADERNO, second]),
    getProduct: async id => [CUADERNO, second].find(p => p.id === id) || null,
    findCustomers: async () => []
  }
  const interpretation = (product_id = null, query = 'cuaderno A4') => ({
    intent: 'sale', items: [{ query, sku: null, quantity: 2, unit: null, product_id }], payment_method: 'efectivo', customer_query: null, question: null
  })
  const unique = await makeLegacyDraftBuilder(async () => interpretation(null, 'cuaderno marca a'), search)(['x'], null)
  assert.equal(saleDraftSchema.parse(unique).items[0].confidence, 'high')
  const ambiguous = await makeLegacyDraftBuilder(async () => interpretation(), search)(['x'], null)
  assert.equal(ambiguous.items[0].product_id, null)
  assert.deepEqual(ambiguous.items[0].candidates, [CUADERNO.id, second.id])
  assert.equal(ambiguous.items[0].doubts[0].code, 'ambiguous_product')
  let shown
  const chosen = await makeLegacyDraftBuilder(async (_m, ctx) => { shown = ctx.candidates.map(p => p.id); return interpretation(second.id) }, search)(['x', 'el de marca B'], ambiguous)
  assert.deepEqual(shown, [CUADERNO.id, second.id])
  assert.equal(chosen.items[0].product_id, second.id)
  assert.equal(chosen.items[0].confidence, 'high')
  const invented = await makeLegacyDraftBuilder(async () => interpretation(randomUUID()), search)(['x'], null)
  assert.equal(invented.items[0].product_id, null)
})

// ---------------------------------------------------------------- SaleProposal (agent 1, hybrid search)

const proposal = (overrides = {}, item = {}) => ({
  confidence: 'high', customer_id: null, payment_method: 'efectivo', total: 10, currency: 'PEN', doubts: [],
  items: [{
    line: 1, query: '2 cuadernos A4', product_id: CUADERNO.id, name: CUADERNO.name, sku: 'CUA-1', brand: 'Marca A',
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
  const medium = proposal({ confidence: 'medium' }, { confidence: 'medium', reasons: ['no se indicó el rayado'], alternatives: [{ product_id: alt, name: 'Otro', sku: 'X', brand: null, score: 0.8 }] })
  const parsed = parseAgentDraft(medium)
  assert.deepEqual(parsed.data.items[0].candidates, [alt])
  assert.deepEqual(parsed.data.items[0].doubts, [{ code: 'other', note: 'no se indicó el rayado' }])
  const { run, counts } = await setup(t, { drafts: [medium] })
  const response = await run(instruction())
  assert.equal(response.status, 'pending_review')
  assert.ok(codes(response).includes('low_confidence'))
  assert.match(response.message, /no se indicó el rayado/)
  assert.equal(counts.execute, 0)
})

test('SaleProposal con precio distinto al oficial o sin forma de pago queda por confirmar', async t => {
  const { run } = await setup(t, { drafts: [proposal({}, { price_unit: 4 }), proposal({ payment_method: null })] })
  assert.deepEqual(codes(await run(instruction('a'))), ['price_changed'])
  assert.deepEqual(codes(await run(instruction('b'))), ['missing_payment'])
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
    drafts: [draftOf({ payment_method: null }), draftOf(), draftOf({ payment_method: null })]
  })
  const review = await run(instruction('vende dos cuadernos'))
  assert.equal(review.status, 'pending_review')
  assert.equal(review.result.dry_run, true)
  assert.equal(review.result.would_be, 'pending_review')
  assert.deepEqual(codes(review), ['missing_payment'])
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
  assert.deepEqual(codes(await run(instruction('a'))), ['price_changed'])
  assert.deepEqual(codes(await run(instruction('b'))), ['insufficient_stock'])
  assert.deepEqual(codes(await run(instruction('c'))), ['invalid_draft'])
  // The simulated reservations of a (2) and b (18) hold the 20 units inside the dry-run store.
  assert.deepEqual(codes(await run(instruction('d'))), ['insufficient_stock'])
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
