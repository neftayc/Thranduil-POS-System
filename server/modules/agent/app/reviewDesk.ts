import { createHash } from 'node:crypto'
import { quantityFitsUnit } from './grounding'
import { reservedFromOperations } from './reservations'
import { PRICE_TOLERANCE, type ValidationCatalog } from './validateDraft'
import {
  AgentBusyError, SaleNotCommittedError, SaleRejectedByPosError,
  type AgentResponse, type DraftItem, type Operation, type Product, type ReviewReason, type ReviewReasonCode, type SaleDraft, type SalesAgentDependencies
} from '../contracts'

// ---------------------------------------------------------------------------
// REVIEW DESK — the POS screen where an owner/manager resolves the "ventas por confirmar" that the
// voice sales agent left (state 'review'). The reviewer decides (product, quantity, price, payment);
// the code only verifies FACTS again (active product, presentation, official price, stock net of other
// reservations, active payment) and registers through the same executor as the agent (create_sale).
// Idempotent by operation: an approved/annulled operation is never registered twice.
// ---------------------------------------------------------------------------

const round = (value: number, places = 4) => Number(value.toFixed(places))
const money = (value: number) => `S/ ${value.toFixed(2)}`
const EPSILON = 0.000001
const MAX_QTY = 1000000
const MAX_LINES = 20
const SELLER_EDITING_MS = 120_000
export const DRY_RUN_PREFIX = 'SIMULACIÓN (dry-run), NO se registró ninguna venta. '

/** Plain-language title of each reason code (the reason's own message carries the detail). */
export const REASON_LABELS: Record<ReviewReasonCode, string> = {
  invalid_draft: 'El agente no pudo armar la venta',
  agent_doubt: 'El agente tiene una duda',
  low_confidence: 'El agente no está seguro del producto',
  product_unresolved: 'Falta elegir el producto',
  product_inactive: 'Producto inexistente o inactivo',
  missing_quantity: 'Cantidad no clara',
  price_unavailable: 'Sin precio de lista',
  price_changed: 'El precio de lista cambió',
  insufficient_stock: 'Stock insuficiente',
  missing_payment: 'Forma de pago no dicha o no clara',
  invalid_payment: 'Forma de pago no disponible',
  invalid_customer: 'Cliente no encontrado',
  pos_rejected: 'El POS rechazó la venta',
  price_override_not_allowed: 'Precio manual no permitido (registro antiguo)',
  unit_unclear: 'Presentación no clara',
  phrase_not_in_order: 'Línea que el vendedor no dijo (posible invento)',
  selector_question: 'Pregunta al vendedor',
  price_modified: 'Precio dictado distinto al de lista',
  price_unverified: 'Precio que el vendedor no dijo'
}

export type ReviewOption = { product_id: string; name: string }
export type ReviewCaseLine = {
  n: number
  /** What the seller said for this line (consolidated phrase or legacy query). */
  phrase: string
  product_id: string | null
  name: string | null
  quantity: number
  unit: string | null
  price_said: number | null
  list_price: number | null
  options: ReviewOption[]
  reasons: number[]
}
export type ReviewCaseReason = { code: ReviewReasonCode; label: string; message: string; line: number | null; options: ReviewOption[] }
export type ReviewCase = {
  id: string
  version: string
  seller_id: string
  saved_at: string
  expires_at: string
  dictation: string[]
  reasons: ReviewCaseReason[]
  lines: ReviewCaseLine[]
  payment_method: string
  /** true when the seller did not say a payment (efectivo by default). */
  payment_defaulted: boolean
  reservations: Array<{ product_id: string; qty: number }>
  price_review: boolean
  notes: string[]
  /** Past POS_AGENT_REVIEW_TTL_HOURS: its reservation was released; stock and price are re-checked on approval. */
  expired: boolean
}
/** Status filter of the review list (owner, 2026-11-16: expired ones in the same list, with a filter). */
export type ReviewFilter = 'pending' | 'expired' | 'all'

/** What the reviewer submits. price_unit null = official list price. */
export type ResolutionLine = { product_id: string; quantity: number; unit: string | null; price_unit: number | null }
export type Resolution = {
  version: string; lines: ResolutionLine[]; payment_method: string; note?: string
  /** Expired sale: the changes_token of the preview whose changes (list price) the reviewer accepted. */
  accept_changes?: string
}
export type Reviewer = { id: string; role: string }

export type CheckedLine = DraftItem & { below_cost: boolean; unit_cost: number | null }
export type CheckResult = {
  ok: boolean
  errors: Array<{ line: number | null; message: string }>
  lines: Array<CheckedLine | null>
  total: number
  payment_method: string | null
  payment_methods: Array<{ code: string; label: string }>
  /** Expired sale only: what changed since the seller dictated it (list price). Approval needs them accepted. */
  changes: Array<{ line: number; message: string }>
  changes_token: string | null
}

export class ReviewNotFoundError extends Error {}
/** The operation cannot be resolved now (already resolved, changed, being edited). */
export class ReviewConflictError extends Error {}
/** The resolution does not pass the fact checks: nothing was registered. */
export class ReviewInvalidError extends Error {
  constructor (public errors: CheckResult['errors'], public changes: CheckResult['changes'] = [], public changesToken: string | null = null) {
    super(errors.map(e => e.message).join(' '))
  }
}
/** create_sale was dispatched and its answer was lost: indeterminate, a person must reconcile it. */
export class ReviewPendingError extends Error {}

export type ReviewDeskDependencies = {
  store: SalesAgentDependencies['store']
  catalog: ValidationCatalog
  /** Same executor the agent uses (create_sale), bound to the REVIEWER's token. Not called in dry-run. */
  execute?: SalesAgentDependencies['execute']
  dryRun: boolean
  reviewTtlMs: number
  now?: () => number
}

/** Changes whenever the seller corrects the sale or the agent re-decides: guards against approving a stale screen. */
export const operationVersion = (op: Operation) => createHash('sha256')
  .update(JSON.stringify([op.state, op.messages.length, op.expires_at, op.reasons || [], op.reservations || []]))
  .digest('hex').slice(0, 16)

const isExpired = (op: Operation, now: number) => op.expires_at <= now
const matchesFilter = (op: Operation, now: number, filter: ReviewFilter) => op.state === 'review' &&
  (filter === 'all' || (filter === 'expired') === isExpired(op, now))

/** Turns an operation file into what the review screen shows. Reads only the file (no catalog calls). */
export const describeOperation = (op: Operation, reviewTtlMs: number, now = Date.now()): ReviewCase => {
  const result = (op.response?.result || {}) as Record<string, any>
  const items: DraftItem[] = Array.isArray(result.items) ? result.items : []
  const names = new Map<string, string>()
  for (const item of items) names.set(item.product_id, item.name)
  for (const reason of op.reasons || []) {
    for (const option of (reason.detail?.options as ReviewOption[] | undefined) || []) {
      if (option?.product_id && option.name) names.set(option.product_id, option.name)
    }
  }
  const optionsOf = (ids: string[]) => ids.map(id => ({ product_id: id, name: names.get(id) || `Producto ${id.slice(0, 8)}` }))
  const used = new Set<DraftItem>()
  const itemFor = (productId: string | null) => {
    const item = productId ? items.find(i => i.product_id === productId && !used.has(i)) : undefined
    if (item) used.add(item)
    return item
  }

  type Raw = { phrase: string; product_id: string | null; quantity: number | null; unit: string | null; price_said: number | null; options: string[] }
  let raw: Raw[]
  if (op.consolidated) {
    raw = op.consolidated.lines.map(l => ({ phrase: l.phrase, product_id: l.product_id, quantity: l.quantity, unit: l.unit, price_said: l.price_said, options: l.options }))
  } else if (op.proposal) {
    raw = op.proposal.items.map(l => ({ phrase: l.query, product_id: l.product_id, quantity: l.quantity, unit: l.unit, price_said: l.price_said, options: l.candidates }))
  } else {
    raw = items.map(i => ({ phrase: i.name, product_id: i.product_id, quantity: i.qty, unit: i.unit_name, price_said: i.list_price !== undefined ? i.price_unit : null, options: [] }))
  }

  const reasons: ReviewCaseReason[] = (op.reasons || []).map((r: ReviewReason) => ({
    code: r.code, label: REASON_LABELS[r.code] || r.code, message: r.message, line: r.line ?? null,
    options: ((r.detail?.options as ReviewOption[] | undefined) || []).filter(o => o?.product_id)
  }))

  const lines: ReviewCaseLine[] = raw.map((l, index) => {
    const n = index + 1
    const item = itemFor(l.product_id)
    const optionIds = [...new Set([...l.options, ...reasons.filter(r => r.line === n).flatMap(r => r.options.map(o => o.product_id))])]
    return {
      n, phrase: l.phrase, product_id: l.product_id,
      name: l.product_id ? names.get(l.product_id) || null : null,
      quantity: item?.qty ?? l.quantity ?? 1,
      unit: item?.unit_name ?? l.unit,
      price_said: l.price_said,
      list_price: item ? (item.list_price ?? item.price_unit) : null,
      options: optionsOf(optionIds.filter(id => id !== l.product_id)),
      reasons: reasons.flatMap((r, i) => r.line === n ? [i] : [])
    }
  })

  return {
    id: op.id,
    version: operationVersion(op),
    seller_id: op.seller_id,
    saved_at: new Date(op.expires_at - reviewTtlMs).toISOString(),
    expires_at: new Date(op.expires_at).toISOString(),
    dictation: op.messages,
    reasons,
    lines,
    payment_method: op.consolidated?.payment_method || op.proposal?.payment_method || 'efectivo',
    payment_defaulted: Boolean(result.payment_defaulted) || (op.consolidated ? !op.consolidated.payment_phrase : !op.proposal?.payment_method),
    reservations: op.reservations || [],
    price_review: op.price_review?.status === 'pending',
    notes: Array.isArray(result.notes) ? result.notes : [],
    expired: isExpired(op, now)
  }
}

export const makeReviewDesk = (deps: ReviewDeskDependencies) => {
  const now = deps.now || Date.now
  const { store, catalog } = deps

  const locked = async <T>(work: () => Promise<T>, attempts = 60): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      try { return await store.exclusive(work) } catch (error) {
        if (!(error instanceof AgentBusyError) || attempt >= attempts) throw error
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    }
  }

  /** Ventas por confirmar, oldest first: pending (live, default), expired (reservation released) or all. */
  const list = async (filter: ReviewFilter = 'pending'): Promise<ReviewCase[]> => (await store.listOperations())
    .filter(op => matchesFilter(op, now(), filter))
    .sort((a, b) => a.expires_at - b.expires_at)
    .map(op => describeOperation(op, deps.reviewTtlMs, now()))

  /** Fact checks over the reviewer's resolution. Never trusts the file's prices or names. */
  const check = async (op: Operation, resolution: Pick<Resolution, 'lines' | 'payment_method'>): Promise<CheckResult & { sale: SaleDraft | null }> => {
    const errors: CheckResult['errors'] = []
    const checked: Array<CheckedLine | null> = []
    const products = new Map<string, Product>()
    const lines = Array.isArray(resolution.lines) ? resolution.lines : []
    if (!lines.length) errors.push({ line: null, message: 'La venta no tiene líneas.' })
    if (lines.length > MAX_LINES) errors.push({ line: null, message: `Máximo ${MAX_LINES} líneas.` })
    const dictated = new Map<string, number[]>()
    const listSeen = new Map<string, number>() // product|unit → list price when the seller dictated it
    const changes: CheckResult['changes'] = []
    const expired = isExpired(op, now())
    for (const l of describeOperation(op, deps.reviewTtlMs, now()).lines) {
      if (l.product_id && l.price_said !== null) dictated.set(l.product_id, [...(dictated.get(l.product_id) || []), l.price_said])
      if (l.product_id && l.list_price !== null && l.unit) listSeen.set(`${l.product_id}|${l.unit}`, l.list_price)
    }

    for (const [index, line] of lines.slice(0, MAX_LINES).entries()) {
      const n = index + 1
      const fail = (message: string) => { errors.push({ line: n, message: `Línea ${n}: ${message}` }); checked.push(null) }
      const product = line?.product_id ? (products.get(line.product_id) || await catalog.getProduct(String(line.product_id))) : null
      if (!product) { fail(line?.product_id ? 'el producto no existe o está inactivo.' : 'elige un producto.'); continue }
      products.set(product.id, product)
      const quantity = Number(line.quantity)
      if (!Number.isFinite(quantity) || quantity <= 0 || quantity > MAX_QTY) { fail(`la cantidad ${line.quantity} no es válida.`); continue }
      let quote: Awaited<ReturnType<ValidationCatalog['quote']>>
      try {
        quote = await catalog.quote(product, quantity, line.unit || null, null)
        if (!Number.isFinite(quote.price) || quote.price < 0 || !Number.isFinite(quote.factor) || quote.factor <= 0 || quote.currency !== 'PEN') throw new Error('Cotización inválida')
      } catch {
        fail(`la presentación «${line.unit || product.unit}» no es válida para ${product.name}.`); continue
      }
      if (!quantityFitsUnit(quantity, quote.unit_name)) { fail(`la cantidad ${quantity} no es válida para la presentación «${quote.unit_name}».`); continue }
      const official = round(quote.price)
      const seen = listSeen.get(`${product.id}|${quote.unit_name}`)
      if (expired && seen !== undefined && Math.abs(seen - official) > PRICE_TOLERANCE) {
        changes.push({ line: n, message: `Línea ${n}: el precio de lista de ${product.name} cambió de ${money(seen)} a ${money(official)} desde el dictado.` })
      }
      const asked = line.price_unit === null || line.price_unit === undefined || (line.price_unit as unknown) === '' ? null : Number(line.price_unit)
      if (asked !== null && (!Number.isFinite(asked) || asked <= 0 || asked > 1000000)) { fail(`el precio ${line.price_unit} no es válido.`); continue }
      if (asked === null && official <= 0) { fail(`${product.name} no tiene precio de lista: indica el precio.`); continue }
      const sold = asked !== null && Math.abs(asked - official) > PRICE_TOLERANCE ? round(asked) : official
      const wasDictated = (dictated.get(product.id) || []).some(p => Math.abs(p - sold) <= PRICE_TOLERANCE)
      const unitCost = Number.isFinite(product.avg_cost) && (product.avg_cost as number) > 0 ? round((product.avg_cost as number) * quote.factor) : null
      checked.push({
        product_id: product.id, name: product.name, qty: quantity, unit_name: quote.unit_name,
        price_unit: sold, factor: quote.factor, total: round(quantity * sold, 2),
        ...(sold !== official ? {
          list_price: official,
          manual_reason: `${wasDictated ? 'Precio dictado por vendedor' : 'Precio corregido'}, aprobado en revisión (lista ${money(official)})`
        } : {}),
        below_cost: unitCost !== null && sold < unitCost - PRICE_TOLERANCE,
        unit_cost: unitCost
      })
    }

    // Stock net of OTHER live reservations (this operation's own reservation is being converted).
    const reserved = reservedFromOperations(await store.listOperations(), now(), op.id)
    const needed = new Map<string, number>()
    for (const item of checked) if (item) needed.set(item.product_id, (needed.get(item.product_id) || 0) + item.qty * item.factor)
    for (const [id, qty] of needed) {
      const product = products.get(id)!
      const held = reserved.get(id) || 0
      const available = round((Number.isFinite(product.stock) ? product.stock : 0) - held)
      if (qty > available + EPSILON) {
        errors.push({ line: null, message: `Stock insuficiente de ${product.name}: hay ${Math.max(available, 0)} ${product.unit} disponibles${held ? ` (${round(held)} reservadas en otras ventas por confirmar)` : ''} y se necesitan ${round(qty)}.` })
      }
    }

    const methods = await catalog.paymentMethods()
    const wanted = String(resolution.payment_method || '').trim().toLowerCase()
    const method = methods.find(m => m.code.toLowerCase() === wanted)
    if (!method) errors.push({ line: null, message: `La forma de pago «${resolution.payment_method || '—'}» no está activa en el POS.` })

    const items = checked.filter((i): i is CheckedLine => Boolean(i))
    const total = round(items.reduce((sum, item) => sum + item.total, 0), 2)
    const ok = !errors.length
    const changesToken = changes.length ? createHash('sha256').update(JSON.stringify(changes)).digest('hex').slice(0, 16) : null
    return {
      ok, errors, lines: checked, total, payment_method: method?.code || null, payment_methods: methods,
      changes, changes_token: changesToken,
      sale: ok ? {
        customer_id: null, payment_method: method!.code, currency: 'PEN', total,
        items: items.map(({ below_cost: _b, unit_cost: _u, ...item }) => item)
      } : null
    }
  }

  const load = async (id: string) => {
    let op: Operation | null
    try { op = await store.getOperation(id) } catch { op = null }
    if (!op) throw new ReviewNotFoundError('Venta por confirmar no encontrada.')
    return op
  }

  /** Can this operation be resolved now? Returns the previous outcome when it was already resolved (idempotency). */
  const guard = (op: Operation, version: string | undefined, decision: 'approve' | 'annul') => {
    if (op.review && op.response && ['completed', 'simulated', 'cancelled'].includes(op.state)) {
      const same = decision === 'approve' ? op.review.decision !== 'annulled' : op.review.decision === 'annulled'
      if (same) return op.response
      throw new ReviewConflictError(`Esta venta ya fue ${op.review.decision === 'annulled' ? 'anulada' : 'aprobada'} en revisión.`)
    }
    if (op.state === 'executing' || (op.execution && !op.execution.settled)) {
      throw new ReviewPendingError('Esta venta se envió al POS y su resultado está pendiente de conciliación. Verifica en el historial de ventas antes de hacer algo más.')
    }
    if (op.state !== 'review') throw new ReviewConflictError(`Esta operación ya no está por confirmar (estado: ${op.state}).`)
    if (op.inflight && now() - op.inflight.started_at < SELLER_EDITING_MS) throw new ReviewConflictError('El vendedor está corrigiendo esta venta en este momento. Espera unos segundos y recarga.')
    if (!version || version !== operationVersion(op)) throw new ReviewConflictError('La venta cambió desde que la abriste (el vendedor la corrigió). Recarga la lista.')
    return null
  }

  const mark = (response: AgentResponse): AgentResponse => deps.dryRun
    ? { ...response, message: `${DRY_RUN_PREFIX}${response.message}`, result: { ...(response.result || {}), dry_run: true } }
    : response

  /** Live check without registering (prices, stock, total). */
  const preview = async (id: string, resolution: Pick<Resolution, 'lines' | 'payment_method'>) => {
    const op = await load(id)
    const { sale: _sale, ...result } = await check(op, resolution)
    return { ...result, dry_run: deps.dryRun }
  }

  const approve = async (id: string, resolution: Resolution, reviewer: Reviewer): Promise<AgentResponse> => locked(async () => {
    const op = await load(id)
    const previous = guard(op, resolution.version, 'approve')
    if (previous) return previous
    const verified = await check(op, resolution)
    if (!verified.ok || !verified.sale) throw new ReviewInvalidError(verified.errors, verified.changes, verified.changes_token)
    // Expired sale: something changed since the dictation (list price) → show it, register nothing,
    // until the reviewer accepts exactly those changes.
    if (verified.changes.length && resolution.accept_changes !== verified.changes_token) {
      throw new ReviewInvalidError([{ line: null, message: 'La venta venció y cambió desde el dictado: revisa los cambios y acéptalos para registrarla.' }, ...verified.changes], verified.changes, verified.changes_token)
    }
    // Owner's decision (2026-11-16): the sale belongs to the SELLER who dictated it; the reviewer is stored as approver.
    const sale: SaleDraft = { ...verified.sale, sold_by: op.seller_id, approved_by: reviewer.id }
    const at = new Date(now()).toISOString()
    const note = String(resolution.note || '').trim().slice(0, 500) || undefined
    const base = { reviewer_id: reviewer.id, reviewer_role: reviewer.role, at, ...(note ? { note } : {}), sale }

    if (deps.dryRun) {
      // Validation only: create_sale is never called; the simulated reservation is released.
      op.state = 'simulated'
      op.draft = sale
      delete op.reservations
      op.review = { decision: 'simulated', ...base }
      op.response = mark({
        status: 'rejected', operation_id: op.id,
        message: `Con datos reales se habría registrado en revisión por ${money(sale.total)}.`,
        result: { would_be: 'completed', reference: null, total: sale.total, currency: sale.currency, items: sale.items, payment_method: sale.payment_method, sold_by: sale.sold_by, reviewed_by: reviewer.id }
      })
      await store.saveOperation(op)
      return op.response
    }

    if (!deps.execute) throw new Error('Registro de ventas no configurado')
    let result: { saleId: string; total: number }
    try {
      result = await deps.execute(sale, async () => {
        op.state = 'executing'
        op.draft = sale
        op.execution = { request_id: `review:${reviewer.id}`, started_at: now(), settled: false }
        // Persist BEFORE create_sale: a lost answer must never lead to a second sale.
        await store.saveOperation(op)
      })
    } catch (error) {
      const dispatched = (op.state as Operation['state']) === 'executing'
      if (error instanceof SaleRejectedByPosError || error instanceof SaleNotCommittedError) {
        // Nothing was registered: it stays por confirmar with its reservation.
        op.state = 'review'
        if (op.execution) op.execution.settled = true
        await store.saveOperation(op)
        throw new ReviewInvalidError([{ line: null, message: error instanceof SaleRejectedByPosError
          ? `El POS rechazó la venta (código ${error.message}); no se registró.`
          : error.message }])
      }
      if (dispatched) throw new ReviewPendingError('No llegó la respuesta del POS: la venta pudo o no registrarse. Verifica en el historial de ventas; no la apruebes de nuevo.')
      throw error
    }
    op.state = 'completed'
    op.execution!.settled = true
    delete op.reservations
    delete op.inflight
    op.review = { decision: 'approved', ...base, sale_id: result.saleId }
    if (op.price_review) {
      // approved = every dictated price was kept as is; adjusted = the reviewer changed something.
      const kept = op.price_review.items.every(p => sale.items.some(i => i.product_id === p.product_id && Math.abs(i.price_unit - p.price_unit) <= PRICE_TOLERANCE))
      op.price_review = { ...op.price_review, status: kept ? 'approved' : 'adjusted', sale_reference: result.saleId }
    }
    op.response = {
      status: 'completed', operation_id: op.id,
      message: `Venta registrada en revisión (referencia ${result.saleId}) por ${money(sale.total)}.`,
      result: { reference: result.saleId, total: sale.total, currency: sale.currency, items: sale.items, payment_method: sale.payment_method, sold_by: sale.sold_by, reviewed_by: reviewer.id }
    }
    try { await store.saveOperation(op) } catch {} // the sale exists: never report it as failed
    return op.response
  })

  const annul = async (id: string, input: { version: string; note?: string }, reviewer: Reviewer): Promise<AgentResponse> => locked(async () => {
    const op = await load(id)
    const previous = guard(op, input.version, 'annul')
    if (previous) return previous
    const note = String(input.note || '').trim().slice(0, 500) || undefined
    op.state = 'cancelled'
    delete op.reservations
    op.review = { decision: 'annulled', reviewer_id: reviewer.id, reviewer_role: reviewer.role, at: new Date(now()).toISOString(), ...(note ? { note } : {}) }
    op.response = mark({ status: 'rejected', operation_id: op.id, message: 'Venta por confirmar anulada en el POS por el revisor. No se registró una venta y se liberó su reserva.' })
    await store.saveOperation(op)
    return op.response
  })

  return { list, preview, approve, annul, paymentMethods: () => catalog.paymentMethods() }
}
