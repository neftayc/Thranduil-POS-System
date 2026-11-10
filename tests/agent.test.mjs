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
const { instructionSchema, AgentConflictError, SaleNotCommittedError } = await jiti.import('../server/modules/agent/contracts.ts')

const product = { id: randomUUID(), name: 'Cuaderno A4 100 hojas cuadriculado', sku: 'CUA-1', brand: 'Marca A', unit: 'unidad', stock: 20 }
const intent = () => ({ intent: 'sale', items: [{ query: product.name, sku: null, quantity: 2, unit: null, product_id: null }], payment_method: 'efectivo', customer_query: null, question: null })
const draft = () => ({ customer_id: null, payment_method: 'efectivo', items: [{ product_id: product.id, name: product.name, qty: 2, unit_name: 'unidad', price_unit: 5, factor: 1, total: 10 }], total: 10, currency: 'PEN' })
const instruction = (text = 'vende dos cuadernos, pago efectivo', extra = {}) => ({ protocol: 'yachay-agent/1', type: 'instruction', request_id: randomUUID(), input: { text, locale: 'es-PE' }, ...extra })
const follow = (id, text = 'sí, confirmo') => instruction(text, { type: 'follow_up', operation_id: id })

async function setup(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'papeleria-agent-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const counts = { interpret: 0, execute: 0 }
  const dependencies = {
    store: makeFileAgentStore(dir),
    interpret: async () => { counts.interpret++; return intent() },
    prepare: async () => ({ draft: draft(), candidates: [product] }),
    execute: async (_draft, beforeCommit) => { await beforeCommit(); counts.execute++; return { saleId: 'sale-test', total: 10 } },
    ...overrides
  }
  return { run: makeSalesAgent(dependencies), dependencies, counts, dir }
}

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

test('prepara y pide confirmación; un reintento no vuelve a interpretar', async t => {
  const { run, counts } = await setup(t)
  const request = instruction()
  const response = await run(request)
  assert.equal(response.status, 'requires_confirmation')
  assert.equal(response.result.draft.total, 10)
  assert.deepEqual(await run(request), response)
  assert.equal(counts.interpret, 1)
  assert.equal(counts.execute, 0)
})

test('rechaza reutilizar request_id con contenido distinto', async t => {
  const { run } = await setup(t)
  const request = instruction()
  await run(request)
  await assert.rejects(run({ ...request, input: { text: 'otra venta' } }), AgentConflictError)
})

test('registra una vez al confirmar y devuelve la misma venta ante reintentos y nuevas confirmaciones', async t => {
  const { run, counts } = await setup(t)
  const prepared = await run(instruction())
  const confirm = follow(prepared.operation_id)
  const completed = await run(confirm)
  assert.equal(completed.status, 'completed')
  assert.equal(completed.result.reference, 'sale-test')
  assert.deepEqual(await run(confirm), completed)
  assert.deepEqual(await run(follow(prepared.operation_id)), completed)
  assert.equal(counts.execute, 1)
})

test('una modificación tras el borrador exige nueva confirmación', async t => {
  const { run, counts } = await setup(t)
  const prepared = await run(instruction())
  assert.equal((await run(follow(prepared.operation_id, 'cambia la cantidad a tres'))).status, 'requires_confirmation')
  assert.equal(counts.execute, 0)
})

test('no interpreta un sí como confirmación cuando falta aclarar el pedido', async t => {
  const { run, counts } = await setup(t, { prepare: async () => ({ candidates: [], question: '¿Qué producto?' }) })
  const prepared = await run(instruction())
  assert.equal(prepared.status, 'needs_clarification')
  assert.equal((await run(follow(prepared.operation_id, 'sí'))).status, 'needs_clarification')
  assert.equal(counts.execute, 0)
})

test('un cambio de precio invalida la confirmación anterior', async t => {
  let calls = 0
  const { run, counts } = await setup(t, { prepare: async () => ({ candidates: [product], draft: { ...draft(), total: ++calls === 1 ? 10 : 12 } }) })
  const prepared = await run(instruction())
  const response = await run(follow(prepared.operation_id))
  assert.equal(response.status, 'requires_confirmation')
  assert.equal(response.result.draft.total, 12)
  assert.equal(counts.execute, 0)
})

test('sin vendedor autorizado rechaza antes de enviar la venta', async t => {
  const { run, dependencies } = await setup(t, { execute: async () => { throw new SaleNotCommittedError('Falta vendedor') } })
  const prepared = await run(instruction())
  const response = await run(follow(prepared.operation_id))
  assert.equal(response.status, 'rejected')
  assert.match(response.message, /Falta vendedor/)
  assert.equal((await dependencies.store.getOperation(prepared.operation_id)).state, 'confirmation')
})

test('una respuesta perdida después de enviar la venta nunca ejecuta otra vez', async t => {
  let commits = 0
  const { run } = await setup(t, { execute: async (_draft, beforeCommit) => { await beforeCommit(); commits++; throw new Error('timeout') } })
  const prepared = await run(instruction())
  const confirm = follow(prepared.operation_id)
  assert.equal((await run(confirm)).status, 'pending')
  assert.equal((await run(confirm)).status, 'pending')
  assert.equal((await run(follow(prepared.operation_id))).status, 'pending')
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
  const prepared = await run(instruction())
  const confirm = follow(prepared.operation_id)
  const result = await run(confirm)
  assert.equal(result.status, 'completed')
  assert.equal(result.result.reference, 'sale-test')
  assert.equal((await run(confirm)).status, 'pending')
  assert.equal(counts.execute, 1)
})

test('cancela un borrador y rechaza seguimientos desconocidos', async t => {
  const { run, counts } = await setup(t)
  assert.equal((await run(follow(randomUUID()))).status, 'rejected')
  const prepared = await run(instruction())
  assert.equal((await run(follow(prepared.operation_id, 'cancelar'))).status, 'rejected')
  assert.equal((await run(follow(prepared.operation_id))).status, 'rejected')
  assert.equal(counts.execute, 0)
})

test('los borradores y las respuestas sobreviven a recrear el agente', async t => {
  const { run, dependencies, counts } = await setup(t)
  const request = instruction()
  const prepared = await run(request)
  const restarted = makeSalesAgent({ ...dependencies, store: makeFileAgentStore((await setup(t)).dir) })
  assert.equal((await restarted(follow(prepared.operation_id))).status, 'rejected')
  const sameStorage = makeSalesAgent(dependencies)
  assert.deepEqual(await sameStorage(request), prepared)
  assert.equal(counts.interpret, 1)
  assert.equal((await sameStorage(follow(prepared.operation_id))).status, 'completed')
})

test('un duplicado concurrente devuelve pending y luego recupera el borrador terminado', async t => {
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
  assert.equal((await first).status, 'requires_confirmation')
  assert.equal((await run(request)).status, 'requires_confirmation')
  assert.equal(counts.execute, 0)
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

test('rechaza borradores vencidos', async t => {
  const { run, dependencies, counts } = await setup(t)
  const prepared = await run(instruction())
  const op = await dependencies.store.getOperation(prepared.operation_id)
  await dependencies.store.saveOperation({ ...op, expires_at: Date.now() - 1 })
  assert.equal((await run(follow(prepared.operation_id))).status, 'rejected')
  assert.equal(counts.execute, 0)
})
