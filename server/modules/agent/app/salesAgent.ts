import { createHash } from 'node:crypto'
import {
  AgentBusyError, AgentConflictError, AgentForbiddenError, SaleNotCommittedError, SaleRejectedByPosError,
  catalogAnswerSchema,
  type AgentResponse, type AgentSeller, type DraftItem, type Instruction, type Operation,
  type DecisionNotes, type PriceReview, type Reservation, type ReviewReason, type SaleDraftV1, type SalesAgentDependencies, type StockAlert
} from '../contracts'
import { parseAgentDraft } from './proposalAdapter'

const normalize = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[.,!¡¿?]/g, '').trim().replace(/\s+/g, ' ')
const cancellations = new Set(['no', 'cancelar', 'cancela', 'cancelar venta', 'cancela la venta', 'anular', 'anula la venta'])
const round = (value: number) => Number(value.toFixed(4))
const DEFAULT_REVIEW_TTL_MS = 48 * 60 * 60 * 1000
const DRY_RUN_PREFIX = 'SIMULACIÓN (dry-run), NO se registró ninguna venta. '
const OTHER_SELLER = 'Esta operación pertenece a otro vendedor.'
const pending = (id: string): AgentResponse => ({
  status: 'pending', operation_id: id,
  message: 'La operación está en proceso o su resultado está pendiente de conciliación. Reintenta con el mismo request_id; no envíes una venta nueva.'
})

const alertText = (alerts: StockAlert[]) => alerts.length
  ? ` Alerta de stock: ${alerts.map(a => a.level === 'out'
    ? `${a.name} agotado`
    : `${a.name}: quedan ${a.available} ${a.unit} (mínimo ${a.min_stock})`).join('; ')}.`
  : ''

/** Notes (quantity defaulted, price changed) and below-cost alerts, appended to every answer. */
const notesText = (extra: DecisionNotes) => [
  ...extra.notes.map(note => ` ${note}`),
  ...extra.price_alerts.map(a => a.unit_cost !== undefined
    ? ` Alerta de precio: ${a.name} se vende a S/ ${a.price_unit.toFixed(2)}, bajo su costo S/ ${a.unit_cost.toFixed(2)}.`
    : ` Alerta: precio bajo para ${a.name} (S/ ${a.price_unit.toFixed(2)}).`)
].join('')
const NO_NOTES: DecisionNotes = { notes: [], price_alerts: [] }

/** Lines with a dictated price ≠ list price in a venta por confirmar: what the reviewer approves. */
const priceReviewFor = (items: DraftItem[], extra: DecisionNotes, reference: string | null, sellerId: string, at: number): PriceReview | undefined => {
  const changed = items.filter(item => item.list_price !== undefined)
  if (!changed.length) return undefined
  const below = new Set(extra.price_alerts.map(a => a.product_id))
  return {
    status: 'pending', sale_reference: reference, seller_id: sellerId, created_at: new Date(at).toISOString(),
    items: changed.map(item => ({ product_id: item.product_id, name: item.name, qty: item.qty, unit_name: item.unit_name, list_price: item.list_price!, price_unit: item.price_unit, below_cost: below.has(item.product_id) }))
  }
}

const holdAll = (items: DraftItem[]): Reservation[] => {
  const totals = new Map<string, number>()
  for (const item of items) totals.set(item.product_id, (totals.get(item.product_id) || 0) + item.qty * item.factor)
  return [...totals].map(([product_id, qty]) => ({ product_id, qty: round(qty) }))
}

/**
 * Orchestrates one seller message:
 *   AGENT 1 (deps.buildDraft, AI)  → sale-draft/1 with product IDs, quantities, confidence and doubts.
 *   PROCESS 2 (deps.validate, code) → re-verifies and decides: register DIRECTLY as the identified
 *   seller, or save a "venta por confirmar" (state review) with coded reasons and a stock reservation.
 *
 * Guarantees: idempotent by request_id (same id + same content → same response, never a second
 * sale); `executing` is persisted before create_sale, so a lost reply is reported as `pending`
 * (indeterminate), never as success and never retried; operations belong to their seller.
 */
export const makeSalesAgent = (deps: SalesAgentDependencies) => async (request: Instruction, seller: AgentSeller): Promise<AgentResponse> => {
  const id = request.operation_id || request.request_id
  const now = deps.now || Date.now
  const reviewTtl = deps.reviewTtlMs ?? DEFAULT_REVIEW_TTL_MS
  const fingerprint = createHash('sha256').update(JSON.stringify([
    request.protocol, request.type, request.operation_id || null, request.input.text, request.input.locale || 'es-PE', seller.id
  ])).digest('hex')

  const replay = async () => {
    const existing = await deps.store.getRequest(request.request_id)
    if (!existing) return null
    if (existing.seller_id !== seller.id) throw new AgentForbiddenError(OTHER_SELLER)
    if (existing.fingerprint !== fingerprint) throw new AgentConflictError('request_id ya utilizado con otro contenido')
    if (existing.response) return existing.response
    const interrupted = await deps.store.getOperation(existing.operation_id)
    return interrupted?.state === 'completed' ? interrupted.response! : pending(existing.operation_id)
  }

  /** Base units held by live (not expired) pending sales, excluding `excludeId`. */
  const reservedTotals = async (excludeId: string | null) => {
    const totals = new Map<string, number>()
    for (const op of await deps.store.listOperations()) {
      if (op.id === excludeId || op.state !== 'review' || op.expires_at <= now()) continue
      for (const r of op.reservations || []) totals.set(r.product_id, (totals.get(r.product_id) || 0) + r.qty)
    }
    return totals
  }

  const alertsFor = async (productIds: string[], own: Reservation[] = [], excludeId: string | null = null): Promise<StockAlert[]> => {
    if (!deps.stockLevels || !productIds.length) return []
    try {
      const levels = await deps.stockLevels([...new Set(productIds)])
      const reserved = await reservedTotals(excludeId)
      for (const r of own) reserved.set(r.product_id, (reserved.get(r.product_id) || 0) + r.qty)
      return levels.flatMap((level): StockAlert[] => {
        const available = round(level.stock - (reserved.get(level.id) || 0))
        const base = { product_id: level.id, name: level.name, unit: level.unit, available, min_stock: level.min_stock }
        if (available <= 0) return [{ ...base, level: 'out' }]
        if (level.min_stock > 0 && available <= level.min_stock) return [{ ...base, level: 'low' }]
        return []
      })
    } catch {
      return [] // Alerts never block or alter the sale result.
    }
  }

  const replayed = await replay()
  if (replayed) return replayed
  try {
    return await deps.store.exclusive(async () => {
      const duplicate = await replay()
      if (duplicate) return duplicate
      let op = await deps.store.getOperation(id)
      if (!op && request.type === 'follow_up') {
        return { status: 'rejected', operation_id: id, message: 'Operación no encontrada. Envía una nueva instrucción.' }
      }
      if (op && op.seller_id !== seller.id) throw new AgentForbiddenError(OTHER_SELLER)
      if (!op) {
        op = { id, state: 'preparing', seller_id: seller.id, messages: [], expires_at: now() + reviewTtl }
      }
      await deps.store.saveRequest(request.request_id, { fingerprint, operation_id: id, seller_id: seller.id })
      const mark = (response: AgentResponse): AgentResponse => deps.dryRun
        ? {
            ...response,
            message: response.message.startsWith(DRY_RUN_PREFIX) ? response.message : `${DRY_RUN_PREFIX}${response.message}`,
            result: { ...(response.result || {}), dry_run: true }
          }
        : response
      const finish = async (response: AgentResponse) => {
        response = mark(response)
        op!.response = response
        await deps.store.saveOperation(op!)
        await deps.store.saveRequest(request.request_id, { fingerprint, operation_id: id, seller_id: seller.id, response })
        return response
      }
      const cancel = (message: string) => {
        op!.state = 'cancelled'
        delete op!.reservations
        return finish({ status: 'rejected', operation_id: id, message })
      }
      const review = async (reasons: ReviewReason[], items: DraftItem[], reservations: Reservation[], extra: DecisionNotes = NO_NOTES) => {
        op!.state = 'review'
        op!.reasons = reasons
        op!.reservations = reservations
        op!.expires_at = now() + reviewTtl
        op!.price_review = priceReviewFor(items, extra, null, seller.id, now())
        if (!op!.price_review) delete op!.price_review
        const alerts = await alertsFor(items.map(i => i.product_id), reservations, op!.id)
        const pendingText = reasons.map(r => r.message).join(' ')
        return finish({
          status: 'pending_review', operation_id: id,
          message: `Venta por confirmar guardada (referencia ${id}). No se registró todavía: se validará en el POS. Motivo: ${pendingText}${reservations.length ? ' Se reservó el stock disponible de los artículos identificados.' : ''}${notesText(extra)}${alertText(alerts)}`,
          result: {
            reference: id,
            // Agent 1's doubt code (ambiguous_product, product_not_found…) and the ungrounded flag are kept.
            reasons: reasons.map(({ code, line, message, detail }) => ({
              code, ...(line ? { line } : {}), message,
              ...(detail?.doubt ? { doubt: detail.doubt } : {}), ...(detail?.ungrounded ? { ungrounded: true } : {})
            })),
            pending: pendingText,
            notes: extra.notes, price_alerts: extra.price_alerts, price_review: op!.price_review ? 'pending' : null,
            items, reservations,
            review_expires_at: new Date(op!.expires_at).toISOString(),
            alerts,
            ...(deps.dryRun ? { would_be: 'pending_review' } : {})
          }
        })
      }

      if (op.state === 'completed' || op.state === 'cancelled' || op.state === 'simulated' || op.state === 'answered') return finish(op.response!)
      if (op.state === 'executing') return finish(pending(id))
      if (op.expires_at <= now()) {
        return cancel('La venta por confirmar venció y se liberó su reserva. Envía una nueva instrucción para consultar precios y stock actuales.')
      }
      if (request.type === 'follow_up' && cancellations.has(normalize(request.input.text))) {
        return cancel('Operación cancelada. No se registró una venta y se liberó cualquier reserva.')
      }
      op.messages.push(request.input.text)
      if (op.messages.length > 20) {
        return finish({ status: 'rejected', operation_id: id, message: 'Se alcanzó el límite de mensajes para esta operación. Inicia un pedido nuevo.' })
      }

      // AGENT 1: build the draft. Its output is untrusted input for process 2.
      let raw: unknown
      try {
        raw = await deps.buildDraft(op.messages, op.proposal || null)
      } catch {
        return finish({ status: 'rejected', operation_id: id, message: 'No se pudo interpretar el pedido. No se registró una venta. Reintenta con otro request_id.' })
      }
      const answer = catalogAnswerSchema.safeParse(raw)
      if (answer.success) {
        // A catalog question: answered with live data; nothing is sold or reserved.
        const response: AgentResponse = {
          status: 'completed', operation_id: id, message: answer.data.message,
          result: { kind: 'catalog_answer', ...answer.data.result, reference: null }
        }
        if (op.state !== 'review') {
          op.state = 'answered'
          return finish(response)
        }
        // Inside an open venta por confirmar: answer without altering that sale (messages, proposal,
        // reasons, reservations and expiry stay as they were).
        const marked = mark(response)
        await deps.store.saveRequest(request.request_id, { fingerprint, operation_id: id, seller_id: seller.id, response: marked })
        return marked
      }
      const parsed = parseAgentDraft(raw, op.messages.join('\n'))
      if (!parsed.success) {
        return review([{ code: 'invalid_draft', message: 'El borrador del agente no respeta el contrato (sale-draft/1 o SaleProposal).' }], [], [])
      }
      // Grounding uses the seller's own messages, never a text supplied by the AI.
      const proposal: SaleDraftV1 = { ...parsed.data, source_text: op.messages.join('\n').slice(0, 5000) }
      op.proposal = proposal
      if (proposal.intent === 'cancel') return cancel('Operación cancelada. No se registró una venta y se liberó cualquier reserva.')
      if (proposal.intent !== 'sale') {
        return finish({ status: 'rejected', operation_id: id, message: 'Esta integración registra ventas. Indica qué productos deseas vender, en qué cantidad y la forma de pago.' })
      }

      // PROCESS 2: deterministic verification and decision.
      let decision: Awaited<ReturnType<SalesAgentDependencies['validate']>>
      try {
        decision = await deps.validate(proposal, await reservedTotals(op.id), { role: seller.role ?? null })
      } catch {
        return finish({ status: 'rejected', operation_id: id, message: 'No se pudo verificar el pedido con el catálogo del POS. No se registró una venta. Reintenta con otro request_id.' })
      }
      if (decision.kind === 'review') return review(decision.reasons, decision.items, decision.reservations, decision)

      op.draft = decision.sale
      delete op.reasons
      delete op.reservations
      delete op.price_review
      if (deps.dryRun) {
        // Validation only: create_sale is never called. Alerts are computed as if the sale had happened.
        op.state = 'simulated'
        const alerts = await alertsFor(op.draft.items.map(i => i.product_id), holdAll(op.draft.items), op.id)
        return finish({
          status: 'rejected', operation_id: id,
          message: `Con datos reales se habría registrado directamente por S/ ${op.draft.total.toFixed(2)}.${notesText(decision)}${alertText(alerts)}`,
          result: { would_be: 'completed', reference: null, total: op.draft.total, currency: op.draft.currency, items: op.draft.items, alerts, notes: decision.notes, price_alerts: decision.price_alerts }
        })
      }
      try {
        const result = await deps.execute(op.draft, async () => {
          op!.state = 'executing'
          // Persist BEFORE calling create_sale. A lost reply must never trigger another sale.
          await deps.store.saveOperation(op!)
        })
        op.state = 'completed'
        const alerts = await alertsFor(op.draft.items.map(i => i.product_id))
        return await finish({
          status: 'completed', operation_id: id,
          message: `Venta registrada correctamente (referencia ${result.saleId}).${notesText(decision)}${alertText(alerts)}`,
          result: { reference: result.saleId, total: result.total, currency: op.draft.currency, items: op.draft.items, alerts, notes: decision.notes, price_alerts: decision.price_alerts }
        })
      } catch (error) {
        // A storage error after receiving the receipt must not report a failed sale.
        // The state changes inside beforeCommit/finish; TypeScript does not follow it, hence the casts.
        const state = op.state as Operation['state']
        if (state === 'completed' && op.response?.status === 'completed') return op.response
        if (error instanceof SaleNotCommittedError) return cancel(error.message)
        if (error instanceof SaleRejectedByPosError) {
          // The database answered with an error: the transaction was rolled back. Keep it for validation,
          // reserving only what is available now (re-checked; falls back to the requested quantities).
          let reservations = holdAll(decision.items)
          try {
            const recheck = await deps.validate(proposal, await reservedTotals(op.id), { role: seller.role ?? null })
            if (recheck.kind === 'review') reservations = recheck.reservations
          } catch {}
          // error.message is only the database error code; details stay in the server log.
          return review([{ code: 'pos_rejected', message: `El POS rechazó la venta (código ${error.message}); no se registró. Revísala en el POS.`, detail: { db_code: error.message } }], decision.items, reservations)
        }
        // After dispatch, any other error may be a lost RPC response rather than a rolled-back sale.
        if (state === 'executing') return finish(pending(id))
        return finish({ status: 'rejected', operation_id: id, message: 'No se pudo registrar la venta. No se envió al POS. Reintenta con otro request_id.' })
      }
    })
  } catch (error) {
    if (error instanceof AgentBusyError) return pending(id)
    throw error
  }
}
