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
const { makeFileAgentStore } = await jiti.import('../server/modules/agent/infra/fileAgentStore.ts')
const { makeSalePreparer } = await jiti.import('../server/modules/agent/app/prepareSale.ts')
const { instructionSchema, AgentConflictError, AgentForbiddenError, SaleNotCommittedError } = await jiti.import('../server/modules/agent/contracts.ts')

const product = { id: randomUUID(), name: 'Cuaderno A4 100 hojas cuadriculado', sku: 'CUA-1', brand: 'Marca A', unit: 'unidad', stock: 20 }
const intent = () => ({ intent: 'sale', items: [{ query: product.name, sku: null, quantity: 2, unit: null, product_id: null }], payment_method: 'efectivo', customer_query: null, question: null })
const draft = () => ({ customer_id: null, payment_method: 'efectivo', items: [{ product_id: product.id, name: product.name, qty: 2, unit_name: 'unidad', price_unit: 5, factor: 1, total: 10 }], total: 10, currency: 'PEN' })
const instruction = (text = 'vende dos cuadernos, pago efectivo', extra = {}) => ({ protocol: 'yachay-agent/1', type: 'instruction', request_id: randomUUID(), input: { text, locale: 'es-PE' }, ...extra })
const follow = (id, text = 'sí, confirmo') => instruction(text, { type: 'follow_up', operation_id: id })

const ANA = { id: 'user-ana' }
const BETO = { id: 'user-beto' }

async function setup(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'papeleria-agent-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const counts = { interpret: 0, execute: 0 }
  const dependencies = {
    store: makeFileAgentStore(dir),
    interpret: async () => { counts.interpret++; return intent() },
    prepare: async () => ({ draft: draft(), items: draft().items, candidates: [product] }),
    execute: async (_draft, beforeCommit) => { await beforeCommit(); counts.execute++; return { saleId: 'sale-test', total: 10 } },
    ...overrides
  }
  const agent = makeSalesAgent(dependencies)
  return { run: (request, seller = ANA) => agent(request, seller), dependencies, counts, dir }
}

const ambiguous = (items = []) => async () => ({ candidates: [product], items, question: 'Artículo 1: elige el producto.' })

const catalog = (overrides = {}) => ({
  findProducts: async () => [product], getProduct: async () => product,
  findCustomers: async () => [], paymentMethods: async () => [{ code: 'efectivo', label: 'Efectivo' }],
  quote: async () => ({ unit_name: 'unidad', price: 5, factor: 1, currency: 'PEN' }),
  ...overrides
})

test('valida protocolo, UUID, límites y vinculación de follow_up', () => {
  assert.equal(instructionSchema.safeParse(instruction()).success, true)
  assert.equal(instructionSchema.safeParse(instruction('', { request_id: 'no-uuid' })).success, false)
  assert.equal(instructionSchema.safeParse(instruction('x'.repeat(2501))).success, false)
  assert.equal(instructionSchema.safeParse(instruction('sí', { type: 'follow_up' })).success, false)
  assert.equal(instructionSchema.safeParse(instruction('vende', { operation_id: randomUUID() })).success, false)
  assert.equal(instructionSchema.safeParse({ ...instruction(), seller_id: randomUUID() }).success, false)
})

test('sin cantidad explícita pide aclaración; no inventa una unidad', async () => {
  const parsed = intent()
  parsed.items[0].quantity = null
  const result = await makeSalePreparer(catalog())(parsed, [])
  assert.equal(result.draft, undefined)
  assert.match(result.question, /cuántas/)
})

test('varias coincidencias exigen elección y un ID inventado se rechaza', async () => {
  const second = { ...product, id: randomUUID(), sku: 'CUA-2', brand: 'Marca B' }
  const result = await makeSalePreparer(catalog({ findProducts: async () => [product, second] }))(intent(), [])
  assert.equal(result.draft, undefined)
  assert.equal(result.candidates.length, 2)
  const parsed = intent()
  parsed.items[0].product_id = randomUUID()
  const invalid = await makeSalePreparer(catalog())(parsed, [product])
  assert.equal(invalid.draft, undefined)
  assert.match(invalid.question, /selección/)
})

test('agrega cantidades de líneas repetidas antes de comprobar stock y conversiones', async () => {
  const parsed = intent()
  parsed.items.push({ ...parsed.items[0] })
  const result = await makeSalePreparer(catalog({ quote: async () => ({ unit_name: 'docena', price: 50, factor: 12, currency: 'PEN' }) }))(parsed, [])
  assert.equal(result.draft, undefined)
  assert.match(result.question, /Stock insuficiente/)
})

test('un SKU explícito se busca como SKU y las ambigüedades semánticas se preguntan', async () => {
  const parsed = intent()
  parsed.items[0].sku = product.sku
  let receivedSku
  const result = await makeSalePreparer(catalog({ findProducts: async (_query, sku) => { receivedSku = sku; return [product] } }))(parsed, [])
  assert.equal(receivedSku, product.sku)
  assert.equal(result.draft.total, 10)
  parsed.question = '¿100 hojas o 100 cuadernos?'
  const ambiguous = await makeSalePreparer(catalog())(parsed, [])
  assert.equal(ambiguous.draft, undefined)
  assert.match(ambiguous.question, /100 hojas/)
})

test('cotiza con el cliente real y no acepta una forma de pago inexistente', async () => {
  const parsed = intent()
  parsed.customer_query = 'Cliente real'
  let quotedCustomer
  const result = await makeSalePreparer(catalog({
    findCustomers: async () => [{ id: 'customer-1', name: 'Cliente real' }],
    quote: async (_p, _qty, _unit, customerId) => { quotedCustomer = customerId; return { unit_name: 'unidad', price: 4, factor: 1, currency: 'PEN' } }
  }))(parsed, [])
  assert.equal(result.draft.total, 8)
  assert.equal(quotedCustomer, 'customer-1')
  parsed.payment_method = 'pago imaginario'
  assert.equal((await makeSalePreparer(catalog())(parsed, [])).draft, undefined)
})

test('registra directamente como el vendedor cuando el pedido es inequívoco; un reintento no duplica', async t => {
  const { run, counts } = await setup(t)
  const request = instruction()
  const response = await run(request)
  assert.equal(response.status, 'completed')
  assert.equal(response.result.reference, 'sale-test')
  assert.match(response.message, /sale-test/)
  assert.deepEqual(await run(request), response)
  assert.equal(counts.interpret, 1)
  assert.equal(counts.execute, 1)
})

test('rechaza reutilizar request_id con contenido distinto', async t => {
  const { run } = await setup(t)
  const request = instruction()
  await run(request)
  await assert.rejects(run({ ...request, input: { text: 'otra venta' } }), AgentConflictError)
})

test('otro vendedor no puede reutilizar el request_id ni continuar la operación', async t => {
  const { run, counts } = await setup(t, { prepare: ambiguous() })
  const request = instruction()
  const review = await run(request, ANA)
  assert.equal(review.status, 'pending_review')
  await assert.rejects(run(request, BETO), AgentForbiddenError)
  await assert.rejects(run(follow(review.operation_id, 'el de marca A'), BETO), AgentForbiddenError)
  await assert.rejects(run(follow(review.operation_id, 'cancelar'), BETO), AgentForbiddenError)
  assert.equal((await run(follow(review.operation_id, 'cancelar'), ANA)).status, 'rejected')
  assert.equal(counts.execute, 0)
})

test('si no puede decidir guarda una venta por confirmar con reserva y no registra', async t => {
  const line = { ...draft().items[0], qty: 3, factor: 2 }
  const { run, counts, dependencies } = await setup(t, { prepare: ambiguous([line]) })
  const response = await run(instruction())
  assert.equal(response.status, 'pending_review')
  assert.equal(response.result.reference, response.operation_id)
  assert.match(response.message, /Venta por confirmar/)
  assert.match(response.message, /No se registró/)
  assert.match(response.result.pending, /elige el producto/)
  const op = await dependencies.store.getOperation(response.operation_id)
  assert.equal(op.state, 'review')
  assert.deepEqual(op.reservations, [{ product_id: product.id, qty: 6 }])
  assert.equal(counts.execute, 0)
})

test('las reservas de ventas por confirmar descuentan el stock disponible de otros pedidos', async t => {
  const line = { ...draft().items[0], qty: 15, factor: 1 }
  let seenReserved
  let calls = 0
  const { run } = await setup(t, {
    prepare: async (_input, _candidates, reserved) => {
      seenReserved = new Map(reserved)
      return ++calls === 1 ? ambiguous([line])() : { draft: draft(), items: draft().items, candidates: [product] }
    }
  })
  const first = await run(instruction('vende 15 cuadernos'))
  assert.equal(first.status, 'pending_review')
  await run(instruction('vende dos cuadernos, pago efectivo'), BETO)
  assert.equal(seenReserved.get(product.id), 15)
})

test('una aclaración posterior completa la venta por confirmar y la registra', async t => {
  let calls = 0
  const { run, counts, dependencies } = await setup(t, {
    prepare: async () => (++calls === 1 ? ambiguous()() : { draft: draft(), items: draft().items, candidates: [product] })
  })
  const review = await run(instruction())
  const completed = await run(follow(review.operation_id, 'el de marca A'))
  assert.equal(completed.status, 'completed')
  assert.equal(counts.execute, 1)
  const op = await dependencies.store.getOperation(review.operation_id)
  assert.equal(op.reservations, undefined)
})

test('cancelar libera la reserva; un seguimiento desconocido se rechaza', async t => {
  const line = { ...draft().items[0] }
  const { run, counts, dependencies } = await setup(t, { prepare: ambiguous([line]) })
  assert.equal((await run(follow(randomUUID()))).status, 'rejected')
  const review = await run(instruction())
  const cancelled = await run(follow(review.operation_id, 'cancelar'))
  assert.equal(cancelled.status, 'rejected')
  assert.match(cancelled.message, /liberó/)
  const op = await dependencies.store.getOperation(review.operation_id)
  assert.equal(op.state, 'cancelled')
  assert.equal(op.reservations, undefined)
  assert.equal((await run(follow(review.operation_id, 'el de marca A'))).status, 'rejected')
  assert.equal(counts.execute, 0)
})

test('una venta por confirmar vencida libera su reserva', async t => {
  const { run, dependencies, counts } = await setup(t, { prepare: ambiguous([draft().items[0]]) })
  const review = await run(instruction())
  const op = await dependencies.store.getOperation(review.operation_id)
  await dependencies.store.saveOperation({ ...op, expires_at: Date.now() - 1 })
  const response = await run(follow(review.operation_id, 'el de marca A'))
  assert.equal(response.status, 'rejected')
  assert.match(response.message, /venció/)
  assert.equal(counts.execute, 0)
})

test('un vendedor sin autorización al registrar no envía la venta', async t => {
  const { run, dependencies } = await setup(t, { execute: async () => { throw new SaleNotCommittedError('Tu usuario no tiene un rol de vendedor válido en el POS. No se registró una venta.') } })
  const response = await run(instruction())
  assert.equal(response.status, 'rejected')
  assert.match(response.message, /rol de vendedor válido/)
  assert.equal((await dependencies.store.getOperation(response.operation_id)).state, 'cancelled')
})

test('una respuesta perdida después de enviar la venta nunca ejecuta otra vez', async t => {
  let commits = 0
  const { run } = await setup(t, { execute: async (_draft, beforeCommit) => { await beforeCommit(); commits++; throw new Error('timeout') } })
  const request = instruction()
  const first = await run(request)
  assert.equal(first.status, 'pending')
  assert.equal((await run(request)).status, 'pending')
  assert.equal((await run(follow(first.operation_id, 'el de marca A'))).status, 'pending')
  assert.equal(commits, 1)
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
  assert.equal(result.result.reference, 'sale-test')
  assert.equal((await run(request, ANA)).status, 'pending')
  assert.equal(counts.execute, 1)
})

test('las respuestas sobreviven a recrear el agente', async t => {
  const { run, dependencies, counts } = await setup(t)
  const request = instruction()
  const done = await run(request)
  const sameStorage = makeSalesAgent(dependencies)
  assert.deepEqual(await sameStorage(request, ANA), done)
  assert.equal(counts.interpret, 1)
  assert.equal(counts.execute, 1)
})

test('un duplicado concurrente devuelve pending y luego recupera el resultado', async t => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  let started
  const ready = new Promise(resolve => { started = resolve })
  const { run, counts } = await setup(t, { interpret: async () => { started(); await gate; return intent() } })
  const request = instruction()
  const first = run(request)
  await ready
  assert.equal((await run(request)).status, 'pending')
  release()
  assert.equal((await first).status, 'completed')
  assert.equal((await run(request)).status, 'completed')
  assert.equal(counts.execute, 1)
})

test('alerta de stock bajo o agotado tras registrar, sin alterar la venta', async t => {
  const { run } = await setup(t, {
    stockLevels: async ids => ids.map(id => ({ id, name: product.name, unit: 'unidad', stock: 3, min_stock: 5 }))
  })
  const response = await run(instruction())
  assert.equal(response.status, 'completed')
  assert.equal(response.result.alerts[0].level, 'low')
  assert.match(response.message, /Alerta de stock: .*quedan 3 unidad \(mínimo 5\)/)
  const failing = await setup(t, { stockLevels: async () => { throw new Error('catálogo caído') } })
  const ok = await failing.run(instruction())
  assert.equal(ok.status, 'completed')
  assert.deepEqual(ok.result.alerts, [])
})

test('la reserva de una venta por confirmar puede dejar el producto agotado y se avisa', async t => {
  const line = { ...draft().items[0], qty: 4, factor: 1 }
  const { run } = await setup(t, {
    prepare: ambiguous([line]),
    stockLevels: async ids => ids.map(id => ({ id, name: 'Cuaderno', unit: 'unidad', stock: 4, min_stock: 2 }))
  })
  const response = await run(instruction())
  assert.equal(response.status, 'pending_review')
  assert.equal(response.result.alerts[0].level, 'out')
  assert.match(response.message, /Cuaderno agotado/)
})

test('el preparador descuenta las reservas al comprobar el stock', async () => {
  const result = await makeSalePreparer(catalog())(intent(), [], new Map([[product.id, 19]]))
  assert.equal(result.draft, undefined)
  assert.match(result.question, /Stock insuficiente.*1 unidad disponibles \(19 reservadas/)
  assert.equal(result.items.length, 1)
})
