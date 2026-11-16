import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// Review desk (POS «Ventas por confirmar»): the sales agent leaves a venta por confirmar; the reviewer resolves it.
const requireNuxt = createRequire(import.meta.resolve('nuxt/package.json'))
const { createJiti } = requireNuxt('jiti')
const jiti = createJiti(import.meta.url)
const { makeSalesAgent } = await jiti.import('../server/modules/agent/app/salesAgent.ts')
const { makeConsolidatedRegistrar } = await jiti.import('../server/modules/agent/app/registrar.ts')
const { makeDraftValidator } = await jiti.import('../server/modules/agent/app/validateDraft.ts')
const { makeFileAgentStore } = await jiti.import('../server/modules/agent/infra/fileAgentStore.ts')
const { reservedFromOperations } = await jiti.import('../server/modules/agent/app/reservations.ts')
const {
  makeReviewDesk, ReviewConflictError, ReviewInvalidError, ReviewPendingError, ReviewNotFoundError
} = await jiti.import('../server/modules/agent/app/reviewDesk.ts')
const { SaleRejectedByPosError } = await jiti.import('../server/modules/agent/contracts.ts')

const CUADERNO = { id: randomUUID(), name: 'Cuaderno A4 cuadriculado', sku: 'CUA-1', brand: 'A', unit: 'unidad', stock: 20, avg_cost: 3 }
const LAPICERO = { id: randomUUID(), name: 'Lapicero azul', sku: 'LAP-1', brand: 'L', unit: 'unidad', stock: 50, avg_cost: 0.8 }
const LAPICERO_R = { id: randomUUID(), name: 'Lapicero rojo', sku: 'LAP-2', brand: 'L', unit: 'unidad', stock: 50, avg_cost: 0.8 }
const SELLER = { id: randomUUID(), role: 'cashier' }
const OWNER = { id: randomUUID(), role: 'owner' }

const makeCatalog = () => {
  const state = {
    products: new Map([CUADERNO, LAPICERO, LAPICERO_R].map(p => [p.id, { ...p }])),
    prices: new Map([[CUADERNO.id, 5], [LAPICERO.id, 1.5], [LAPICERO_R.id, 1.5]]),
    units: { unidad: 1, docena: 12 }
  }
  const catalog = {
    getProduct: async id => (state.products.has(id) ? { ...state.products.get(id) } : null),
    paymentMethods: async () => [{ code: 'efectivo', label: 'Efectivo' }, { code: 'yape', label: 'Yape' }],
    customerExists: async () => false,
    quote: async (product, _qty, unit) => {
      const factor = unit ? state.units[unit] : 1
      if (!factor) throw new Error('presentación no existe')
      return { unit_name: unit || product.unit, price: state.prices.get(product.id) * factor, factor, currency: 'PEN' }
    },
    stockLevels: async () => []
  }
  return { state, catalog }
}

const consolidated = (lines, extra = {}) => ({
  contract: 'sale-consolidated/1', payment_method: 'efectivo', payment_phrase: null, questions: [],
  lines: lines.map(l => ({ unit: null, price_said: null, confidence: 'alta', reason: '', question: null, options: [], ...l })),
  ...extra
})

/** A temp store + the real sales agent (selector stubbed) + the review desk, both on the SAME store. */
const setup = async ({ dryRun = false, execute } = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'review-desk-'))
  const store = makeFileAgentStore(dir)
  const { state, catalog } = makeCatalog()
  let clock = Date.parse('2026-11-16T15:00:00Z')
  const now = () => clock
  const calls = { agent: 0, desk: [] }
  let next = null
  const agent = makeSalesAgent({
    store, now, dryRun, reviewTtlMs: 48 * 3600_000,
    buildDraft: async () => next,
    registrar: makeConsolidatedRegistrar(catalog),
    validate: makeDraftValidator(catalog),
    execute: async () => { calls.agent++; throw new Error('el agente no debe registrar en estos tests') }
  })
  const deskExecute = execute || (async (draft, beforeCommit) => {
    await beforeCommit()
    calls.desk.push(draft)
    return { saleId: `sale-${calls.desk.length}`, total: draft.total }
  })
  const desk = makeReviewDesk({ store, catalog, dryRun, reviewTtlMs: 48 * 3600_000, now, execute: deskExecute })
  const dictate = async (text, sale) => {
    next = sale
    return agent({ protocol: 'yachay-agent/1', type: 'instruction', request_id: randomUUID(), input: { text } }, SELLER)
  }
  const followUp = async (operation_id, text, sale) => {
    next = sale
    return agent({ protocol: 'yachay-agent/1', type: 'follow_up', operation_id, request_id: randomUUID(), input: { text } }, SELLER)
  }
  return {
    dir, store, state, catalog, desk, calls, dictate, followUp,
    tick: ms => { clock += ms },
    reserved: async () => reservedFromOperations(await store.listOperations(), now()),
    cleanup: () => rm(dir, { recursive: true, force: true })
  }
}

/** Resolution exactly as the screen pre-fills it (option A: dictated price kept). */
const prefilled = c => ({
  version: c.version, payment_method: c.payment_method,
  lines: c.lines.map(l => ({ product_id: l.product_id, quantity: l.quantity, unit: l.unit, price_unit: l.price_said }))
})

const priceModifiedSale = async t => {
  const answer = await t.dictate('2 cuadernos a 6 soles', consolidated([{ phrase: '2 cuadernos a 6 soles', product_id: CUADERNO.id, quantity: 2, price_said: 6 }]))
  assert.equal(answer.status, 'pending_review')
  return answer.operation_id
}

test('lista la venta por confirmar con motivo en lenguaje claro, línea, precio dictado y de lista', async () => {
  const t = await setup()
  try {
    const id = await priceModifiedSale(t)
    const [c] = await t.desk.list()
    assert.equal(c.id, id)
    assert.equal(c.seller_id, SELLER.id)
    assert.deepEqual(c.dictation, ['2 cuadernos a 6 soles'])
    assert.equal(c.lines.length, 1)
    assert.equal(c.lines[0].name, CUADERNO.name)
    assert.equal(c.lines[0].quantity, 2)
    assert.equal(c.lines[0].price_said, 6)
    assert.equal(c.lines[0].list_price, 5)
    const reason = c.reasons[c.lines[0].reasons[0]]
    assert.equal(reason.code, 'price_modified')
    assert.equal(reason.label, 'Precio dictado distinto al de lista')
    assert.equal(c.payment_method, 'efectivo')
    assert.equal(c.payment_defaulted, true)
    assert.equal(c.price_review, true)
  } finally { await t.cleanup() }
})

test('opción A: aprobar registra a precio dictado conservando el de lista, una sola vez (idempotente)', async () => {
  const t = await setup()
  try {
    const id = await priceModifiedSale(t)
    assert.equal((await t.reserved()).get(CUADERNO.id), 2)
    const [c] = await t.desk.list()
    const preview = await t.desk.preview(id, prefilled(c))
    assert.equal(preview.ok, true)
    assert.equal(preview.total, 12)
    assert.equal(preview.lines[0].list_price, 5)
    assert.equal(preview.lines[0].below_cost, false)
    assert.equal(t.calls.desk.length, 0, 'verificar no registra')

    const done = await t.desk.approve(id, prefilled(c), OWNER)
    assert.equal(done.status, 'completed')
    assert.equal(t.calls.desk.length, 1)
    const sent = t.calls.desk[0].items[0]
    assert.equal(sent.price_unit, 6)
    assert.equal(sent.list_price, 5)
    assert.match(sent.manual_reason, /Precio dictado por vendedor, aprobado en revisión \(lista S\/ 5\.00\)/)
    assert.equal(t.calls.agent, 0)

    const again = await t.desk.approve(id, prefilled(c), OWNER)
    assert.deepEqual(again, done)
    assert.equal(t.calls.desk.length, 1, 'nunca una segunda venta')
    const op = await t.store.getOperation(id)
    assert.equal(op.state, 'completed')
    assert.equal(op.review.decision, 'approved')
    assert.equal(op.review.sale_id, 'sale-1')
    assert.equal(op.price_review.status, 'approved')
    assert.equal(op.price_review.sale_reference, 'sale-1')
    assert.equal((await t.reserved()).size, 0, 'la reserva se convirtió en venta')
    assert.equal((await t.desk.list()).length, 0)
    // The seller asking again gets the reviewer's outcome, never a second sale.
    const replay = await t.followUp(id, 'y la venta?', null)
    assert.equal(replay.status, 'completed')
    assert.match(replay.message, /registrada en revisión/)
  } finally { await t.cleanup() }
})

test('el revisor corrige el precio al de lista: price_review queda adjusted y no hay manual_reason', async () => {
  const t = await setup()
  try {
    const id = await priceModifiedSale(t)
    const [c] = await t.desk.list()
    const resolution = { ...prefilled(c), lines: [{ ...prefilled(c).lines[0], price_unit: null }] }
    await t.desk.approve(id, resolution, OWNER)
    const sent = t.calls.desk[0].items[0]
    assert.equal(sent.price_unit, 5)
    assert.equal(sent.list_price, undefined)
    assert.equal(sent.manual_reason, undefined)
    assert.equal((await t.store.getOperation(id)).price_review.status, 'adjusted')
  } finally { await t.cleanup() }
})

test('pregunta del selector: muestra sus opciones reales y el revisor elige una', async () => {
  const t = await setup()
  try {
    const answer = await t.dictate('3 lapiceros', consolidated([{
      phrase: '3 lapiceros', product_id: null, quantity: 3, confidence: 'baja', question: '¿Azul o rojo?', options: [LAPICERO.id, LAPICERO_R.id]
    }]))
    assert.equal(answer.status, 'pending_review')
    const [c] = await t.desk.list()
    assert.equal(c.lines[0].product_id, null)
    assert.deepEqual(c.lines[0].options.map(o => o.name), ['Lapicero azul', 'Lapicero rojo'])
    assert.equal(c.reasons[0].label, 'Pregunta al vendedor')
    const missing = await t.desk.preview(c.id, prefilled(c))
    assert.equal(missing.ok, false)
    assert.match(missing.errors[0].message, /elige un producto/)
    const resolution = { ...prefilled(c), lines: [{ product_id: LAPICERO_R.id, quantity: 3, unit: null, price_unit: null }] }
    const done = await t.desk.approve(c.id, resolution, { id: randomUUID(), role: 'manager' })
    assert.equal(done.status, 'completed')
    assert.equal(t.calls.desk[0].items[0].product_id, LAPICERO_R.id)
    assert.equal(t.calls.desk[0].total, 4.5)
  } finally { await t.cleanup() }
})

test('verifica hechos: producto inactivo, presentación inválida, stock reservado por otra venta, pago inactivo', async () => {
  const t = await setup()
  try {
    const id = await priceModifiedSale(t)
    // Another pending sale holds 15 of the 20 notebooks.
    await t.dictate('15 cuadernos a 6 soles', consolidated([{ phrase: '15 cuadernos a 6 soles', product_id: CUADERNO.id, quantity: 15, price_said: 6 }]))
    const c = (await t.desk.list()).find(x => x.id === id)
    const tooMany = await t.desk.preview(id, { ...prefilled(c), lines: [{ product_id: CUADERNO.id, quantity: 6, unit: null, price_unit: 6 }] })
    assert.equal(tooMany.ok, false)
    assert.match(tooMany.errors.map(e => e.message).join(' '), /Stock insuficiente de Cuaderno.*15 reservadas/)
    const ok = await t.desk.preview(id, prefilled(c)) // its own 2 do not count against itself
    assert.equal(ok.ok, true)

    const bad = await t.desk.preview(id, {
      payment_method: 'tarjeta',
      lines: [
        { product_id: randomUUID(), quantity: 1, unit: null, price_unit: null },
        { product_id: LAPICERO.id, quantity: 1, unit: 'caja', price_unit: null },
        { product_id: LAPICERO.id, quantity: 1.5, unit: null, price_unit: null },
        { product_id: LAPICERO.id, quantity: 1, unit: null, price_unit: -2 }
      ]
    })
    const text = bad.errors.map(e => e.message).join(' | ')
    assert.match(text, /Línea 1: el producto no existe o está inactivo/)
    assert.match(text, /Línea 2: la presentación «caja» no es válida/)
    assert.match(text, /Línea 3: la cantidad 1\.5 no es válida/)
    assert.match(text, /Línea 4: el precio -2 no es válido/)
    assert.match(text, /forma de pago «tarjeta» no está activa/)
    await assert.rejects(t.desk.approve(id, { ...prefilled(c), payment_method: 'tarjeta' }, OWNER), ReviewInvalidError)
    assert.equal(t.calls.desk.length, 0)
  } finally { await t.cleanup() }
})

test('precio 0 en catálogo: exige precio; bajo costo se avisa con el costo', async () => {
  const t = await setup()
  try {
    t.state.prices.set(LAPICERO.id, 0)
    const answer = await t.dictate('4 lapiceros', consolidated([{ phrase: '4 lapiceros', product_id: LAPICERO.id, quantity: 4 }]))
    assert.equal(answer.status, 'pending_review')
    const [c] = await t.desk.list()
    assert.equal(c.reasons[0].code, 'price_unavailable')
    assert.equal(c.reasons[0].label, 'Sin precio de lista')
    const noPrice = await t.desk.preview(c.id, prefilled(c))
    assert.match(noPrice.errors[0].message, /no tiene precio de lista: indica el precio/)
    const low = await t.desk.preview(c.id, { ...prefilled(c), lines: [{ product_id: LAPICERO.id, quantity: 4, unit: null, price_unit: 0.5 }] })
    assert.equal(low.ok, true)
    assert.equal(low.lines[0].below_cost, true)
    assert.equal(low.lines[0].unit_cost, 0.8)
    await t.desk.approve(c.id, { ...prefilled(c), lines: [{ product_id: LAPICERO.id, quantity: 4, unit: null, price_unit: 0.5 }] }, OWNER)
    assert.match(t.calls.desk[0].items[0].manual_reason, /^Precio corregido, aprobado en revisión/)
  } finally { await t.cleanup() }
})

test('anular libera la reserva, guarda el archivo para auditoría y el vendedor ve la anulación', async () => {
  const t = await setup()
  try {
    const id = await priceModifiedSale(t)
    const [c] = await t.desk.list()
    const res = await t.desk.annul(id, { version: c.version, note: 'cliente se fue' }, OWNER)
    assert.equal(res.status, 'rejected')
    assert.match(res.message, /anulada en el POS/)
    assert.equal((await t.reserved()).size, 0)
    const op = await t.store.getOperation(id)
    assert.equal(op.state, 'cancelled')
    assert.equal(op.review.decision, 'annulled')
    assert.equal(op.review.note, 'cliente se fue')
    assert.ok(op.consolidated && op.reasons.length, 'se conserva lo dictado y los motivos')
    assert.ok((await readdir(t.dir)).includes(`operation-${id}.json`))
    assert.deepEqual(await t.desk.annul(id, { version: c.version }, OWNER), res, 'idempotente')
    await assert.rejects(t.desk.approve(id, prefilled(c), OWNER), ReviewConflictError)
    const seller = await t.followUp(id, 'y?', null)
    assert.match(seller.message, /anulada en el POS/)
    assert.equal(t.calls.desk.length, 0)
  } finally { await t.cleanup() }
})

test('pantalla vieja: si el vendedor corrigió la venta, aprobar pide recargar', async () => {
  const t = await setup()
  try {
    const id = await priceModifiedSale(t)
    const [stale] = await t.desk.list()
    await t.followUp(id, 'mejor 3 cuadernos a 6 soles', consolidated([{ phrase: '3 cuadernos a 6 soles', product_id: CUADERNO.id, quantity: 3, price_said: 6 }]))
    await assert.rejects(t.desk.approve(id, prefilled(stale), OWNER), /cambió desde que la abriste/)
    await assert.rejects(t.desk.annul(id, { version: stale.version }, OWNER), ReviewConflictError)
    const [fresh] = await t.desk.list()
    assert.equal(fresh.lines[0].quantity, 3)
    await t.desk.approve(id, prefilled(fresh), OWNER)
    assert.equal(t.calls.desk[0].items[0].qty, 3)
  } finally { await t.cleanup() }
})

test('vencidas: misma lista con filtro Pendientes (por defecto) / Vencidas / Todas y marca vencida', async () => {
  const t = await setup()
  try {
    const old = await priceModifiedSale(t)
    t.tick(48 * 3600_000 + 1)
    const fresh = await t.dictate('3 lapiceros a 2 soles', consolidated([{ phrase: '3 lapiceros a 2 soles', product_id: LAPICERO.id, quantity: 3, price_said: 2 }]))
    assert.deepEqual((await t.desk.list()).map(c => [c.id, c.expired]), [[fresh.operation_id, false]])
    assert.deepEqual((await t.desk.list('pending')).map(c => c.id), [fresh.operation_id])
    assert.deepEqual((await t.desk.list('expired')).map(c => [c.id, c.expired]), [[old, true]])
    assert.deepEqual((await t.desk.list('all')).map(c => [c.id, c.expired]), [[old, true], [fresh.operation_id, false]])
    await assert.rejects(t.desk.approve(randomUUID(), { version: 'x', lines: [], payment_method: 'efectivo' }, OWNER), ReviewNotFoundError)
  } finally { await t.cleanup() }
})

test('vencida sin cambios: al aprobar se re-chequea stock (ya sin reserva) y se registra una sola vez', async () => {
  const t = await setup()
  try {
    const id = await priceModifiedSale(t)
    t.tick(48 * 3600_000 + 1)
    assert.equal((await t.reserved()).size, 0, 'la reserva ya se liberó')
    const [c] = await t.desk.list('expired')
    const preview = await t.desk.preview(id, prefilled(c))
    assert.equal(preview.ok, true)
    assert.deepEqual(preview.changes, [])
    const done = await t.desk.approve(id, prefilled(c), OWNER)
    assert.equal(done.status, 'completed')
    assert.deepEqual(await t.desk.approve(id, prefilled(c), OWNER), done)
    assert.equal(t.calls.desk.length, 1)
    assert.equal(t.calls.desk[0].items[0].price_unit, 6)
    assert.equal((await t.desk.list('all')).length, 0)
  } finally { await t.cleanup() }
})

test('vencida: si otra venta tomó el stock, se muestra y no se registra', async () => {
  const t = await setup()
  try {
    const id = await priceModifiedSale(t)
    t.tick(48 * 3600_000 + 1)
    // A new pending sale now holds 19 of the 20 notebooks; the expired one needs 2.
    await t.dictate('19 cuadernos a 6 soles', consolidated([{ phrase: '19 cuadernos a 6 soles', product_id: CUADERNO.id, quantity: 19, price_said: 6 }]))
    const [c] = await t.desk.list('expired')
    const preview = await t.desk.preview(id, prefilled(c))
    assert.equal(preview.ok, false)
    assert.match(preview.errors[0].message, /Stock insuficiente de Cuaderno.*hay 1 .*19 reservadas/)
    await assert.rejects(t.desk.approve(id, prefilled(c), OWNER), ReviewInvalidError)
    assert.equal(t.calls.desk.length, 0)
    assert.equal((await t.store.getOperation(id)).state, 'review')
  } finally { await t.cleanup() }
})

test('vencida: si cambió el precio de lista, se muestra y no se registra hasta aceptar ese cambio', async () => {
  const t = await setup()
  try {
    const answer = await t.dictate('2 cuadernos', consolidated([{ phrase: '2 cuadernos', product_id: CUADERNO.id, quantity: 2, confidence: 'baja', question: '¿A4?' }]))
    assert.equal(answer.status, 'pending_review')
    t.tick(48 * 3600_000 + 1)
    t.state.prices.set(CUADERNO.id, 5.5)
    const [c] = await t.desk.list('expired')
    assert.equal(c.lines[0].list_price, 5)
    const preview = await t.desk.preview(c.id, prefilled(c))
    assert.equal(preview.ok, true)
    assert.equal(preview.total, 11)
    assert.match(preview.changes[0].message, /cambió de S\/ 5\.00 a S\/ 5\.50/)
    assert.ok(preview.changes_token)
    await assert.rejects(t.desk.approve(c.id, prefilled(c), OWNER), err =>
      err instanceof ReviewInvalidError && err.changes.length === 1 && /venció y cambió/.test(err.message))
    await assert.rejects(t.desk.approve(c.id, { ...prefilled(c), accept_changes: 'otro' }, OWNER), ReviewInvalidError)
    assert.equal(t.calls.desk.length, 0, 'nada registrado sin aceptar')
    const done = await t.desk.approve(c.id, { ...prefilled(c), accept_changes: preview.changes_token }, OWNER)
    assert.equal(done.status, 'completed')
    assert.equal(t.calls.desk[0].items[0].price_unit, 5.5)
    // A pending (not expired) sale is not subject to this check.
    t.state.prices.set(CUADERNO.id, 6)
    const live = await t.dictate('1 cuaderno', consolidated([{ phrase: '1 cuaderno', product_id: CUADERNO.id, quantity: 1, confidence: 'baja', question: '¿A4?' }]))
    const [p] = await t.desk.list()
    t.state.prices.set(CUADERNO.id, 7)
    assert.deepEqual((await t.desk.preview(live.operation_id, prefilled(p))).changes, [])
  } finally { await t.cleanup() }
})

test('vencida: anular funciona igual que una pendiente', async () => {
  const t = await setup()
  try {
    const id = await priceModifiedSale(t)
    t.tick(48 * 3600_000 + 1)
    const [c] = await t.desk.list('expired')
    const res = await t.desk.annul(id, { version: c.version, note: 'no volvió' }, OWNER)
    assert.match(res.message, /anulada en el POS/)
    assert.deepEqual(await t.desk.annul(id, { version: c.version }, OWNER), res)
    const op = await t.store.getOperation(id)
    assert.equal(op.state, 'cancelled')
    assert.equal(op.review.decision, 'annulled')
    assert.equal((await t.desk.list('all')).length, 0)
  } finally { await t.cleanup() }
})

test('vencida en simulación (dry-run): aprobar solo muestra lo que haría', async () => {
  let executorCalls = 0
  const t = await setup({ dryRun: true, execute: async () => { executorCalls++; throw new Error('no') } })
  try {
    const id = await priceModifiedSale(t)
    t.tick(48 * 3600_000 + 1)
    const [c] = await t.desk.list('expired')
    const done = await t.desk.approve(id, prefilled(c), OWNER)
    assert.equal(done.result.would_be, 'completed')
    assert.equal(done.result.dry_run, true)
    assert.deepEqual(await t.desk.approve(id, prefilled(c), OWNER), done)
    assert.equal(executorCalls, 0)
    assert.equal((await t.store.getOperation(id)).state, 'simulated')
  } finally { await t.cleanup() }
})

test('el POS rechaza: no se registró, sigue por confirmar con su reserva', async () => {
  const t = await setup({ execute: async (_draft, beforeCommit) => { await beforeCommit(); throw new SaleRejectedByPosError('P0001') } })
  try {
    const id = await priceModifiedSale(t)
    const [c] = await t.desk.list()
    await assert.rejects(t.desk.approve(id, prefilled(c), OWNER), err => err instanceof ReviewInvalidError && /código P0001/.test(err.message))
    const op = await t.store.getOperation(id)
    assert.equal(op.state, 'review')
    assert.equal(op.execution.settled, true)
    assert.equal((await t.reserved()).get(CUADERNO.id), 2)
    assert.equal((await t.desk.list()).length, 1)
  } finally { await t.cleanup() }
})

test('respuesta perdida tras enviar: queda pendiente de conciliación y no se puede reintentar', async () => {
  let sent = 0
  const t = await setup({ execute: async (_draft, beforeCommit) => { await beforeCommit(); sent++; throw new Error('fetch failed') } })
  try {
    const id = await priceModifiedSale(t)
    const [c] = await t.desk.list()
    await assert.rejects(t.desk.approve(id, prefilled(c), OWNER), ReviewPendingError)
    await assert.rejects(t.desk.approve(id, prefilled(c), OWNER), ReviewPendingError)
    assert.equal(sent, 1)
    assert.equal((await t.store.getOperation(id)).state, 'executing')
  } finally { await t.cleanup() }
})

test('e2e simulación (dry-run): dictado → por confirmar → aprobar muestra lo que haría, sin create_sale', async () => {
  let executorCalls = 0
  const t = await setup({ dryRun: true, execute: async () => { executorCalls++; throw new Error('create_sale no debe llamarse en dry-run') } })
  try {
    const a = await t.dictate('2 cuadernos a 6 soles y 3 lapiceros', consolidated([
      { phrase: '2 cuadernos a 6 soles', product_id: CUADERNO.id, quantity: 2, price_said: 6 },
      { phrase: '3 lapiceros', product_id: null, quantity: 3, confidence: 'baja', question: '¿Azul o rojo?', options: [LAPICERO.id, LAPICERO_R.id] }
    ]))
    assert.equal(a.status, 'pending_review')
    assert.equal(a.result.dry_run, true)
    const b = await t.dictate('1 lapicero azul', consolidated([{ phrase: '1 lapicero azul', product_id: LAPICERO.id, quantity: 1 }]))
    assert.equal(b.status, 'rejected')
    assert.equal(b.result.would_be, 'completed')

    const cases = await t.desk.list()
    assert.equal(cases.length, 1)
    const [c] = cases
    assert.equal(c.lines.length, 2)
    const resolution = { ...prefilled(c), lines: [prefilled(c).lines[0], { product_id: LAPICERO.id, quantity: 3, unit: null, price_unit: null }] }
    const preview = await t.desk.preview(c.id, resolution)
    assert.equal(preview.dry_run, true)
    assert.equal(preview.total, 16.5)

    const done = await t.desk.approve(c.id, resolution, OWNER)
    assert.equal(done.status, 'rejected')
    assert.equal(done.result.would_be, 'completed')
    assert.equal(done.result.dry_run, true)
    assert.match(done.message, /^SIMULACIÓN \(dry-run\), NO se registró ninguna venta\. Con datos reales se habría registrado en revisión por S\/ 16\.50/)
    assert.equal(executorCalls, 0)
    assert.equal(t.calls.agent, 0)
    const op = await t.store.getOperation(c.id)
    assert.equal(op.state, 'simulated')
    assert.equal(op.review.decision, 'simulated')
    assert.equal(op.review.sale.items[0].list_price, 5)
    assert.equal((await t.reserved()).size, 0)
    assert.deepEqual(await t.desk.approve(c.id, resolution, OWNER), done)
    assert.equal(executorCalls, 0)
  } finally { await t.cleanup() }
})
