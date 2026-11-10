import { createHash } from 'node:crypto'
import {
  AgentBusyError, AgentConflictError, AgentForbiddenError, SaleNotCommittedError,
  type AgentResponse, type AgentSeller, type DraftItem, type Instruction, type Operation,
  type Reservation, type SalesAgentDependencies, type StockAlert
} from '../contracts'

const normalize = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[.,!¡¿?]/g, '').trim().replace(/\s+/g, ' ')
const cancellations = new Set(['no', 'cancelar', 'cancela', 'cancelar venta', 'cancela la venta', 'anular', 'anula la venta'])
const round = (value: number) => Number(value.toFixed(4))
const DEFAULT_REVIEW_TTL_MS = 48 * 60 * 60 * 1000
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

/**
 * The POS sales agent. It registers the sale directly AS THE IDENTIFIED SELLER when the
 * decision is unambiguous (single product, quantity, price, stock and payment method).
 * Otherwise it saves a "venta por confirmar" (state review) that reserves the resolved
 * stock and is validated later in the POS. Operations are bound to the seller that
 * created them.
 */
export const makeSalesAgent = (deps: SalesAgentDependencies) => async (request: Instruction, seller: AgentSeller): Promise<AgentResponse> => {
  const id = request.operation_id || request.request_id
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

  const reservedTotals = async (excludeId: string | null) => {
    const totals = new Map<string, number>()
    for (const op of await deps.store.listOperations()) {
      if (op.id === excludeId || op.state !== 'review' || op.expires_at <= Date.now()) continue
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
        op = { id, state: 'preparing', seller_id: seller.id, messages: [], candidates: [], expires_at: Date.now() + reviewTtl }
      }
      await deps.store.saveRequest(request.request_id, { fingerprint, operation_id: id, seller_id: seller.id })
      const finish = async (response: AgentResponse) => {
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
      if (op.state === 'completed' || op.state === 'cancelled') return finish(op.response!)
      if (op.state === 'executing') return finish(pending(id))
      if (op.expires_at < Date.now()) {
        return cancel('La venta por confirmar venció y se liberó su reserva. Envía una nueva instrucción para consultar precios y stock actuales.')
      }
      if (request.type === 'follow_up' && cancellations.has(normalize(request.input.text))) {
        return cancel('Operación cancelada. No se registró una venta y se liberó cualquier reserva.')
      }
      op.messages.push(request.input.text)
      if (op.messages.length > 20) {
        return finish({ status: 'rejected', operation_id: id, message: 'Se alcanzó el límite de mensajes para esta operación. Inicia un pedido nuevo.' })
      }

      let prepared: Awaited<ReturnType<SalesAgentDependencies['prepare']>>
      try {
        const parsed = await deps.interpret(op.messages, op)
        op.interpretation = parsed
        if (parsed.intent === 'cancel') return cancel('Operación cancelada. No se registró una venta y se liberó cualquier reserva.')
        if (parsed.intent !== 'sale') {
          return finish({ status: 'rejected', operation_id: id, message: 'Esta integración registra ventas. Indica qué productos deseas vender, en qué cantidad y la forma de pago.' })
        }
        prepared = await deps.prepare(parsed, op.candidates, await reservedTotals(op.id))
        op.candidates = prepared.candidates
      } catch {
        return finish({ status: 'rejected', operation_id: id, message: 'No se pudo procesar el pedido. No se registró una venta. Comprueba el servicio de interpretación y el acceso al catálogo; reintenta con otro request_id.' })
      }

      if (!prepared.draft) {
        // Not decidable: save as "venta por confirmar" with what was understood.
        const items: DraftItem[] = prepared.items || []
        op.state = 'review'
        op.question = prepared.question || 'Faltan datos del pedido.'
        op.reservations = items.map(item => ({ product_id: item.product_id, qty: round(item.qty * item.factor) }))
        op.expires_at = Date.now() + reviewTtl
        delete op.draft
        const alerts = await alertsFor(items.map(i => i.product_id), op.reservations, op.id)
        return finish({
          status: 'pending_review', operation_id: id,
          message: `Venta por confirmar guardada (referencia ${id}). No se registró todavía: se validará en el POS. Pendiente: ${op.question}${op.reservations.length ? ' Se reservó el stock de los artículos identificados.' : ''}${alertText(alerts)}`,
          result: {
            reference: id, pending: op.question, items, candidates: prepared.candidates,
            review_expires_at: new Date(op.expires_at).toISOString(), alerts
          }
        })
      }

      op.draft = prepared.draft
      delete op.reservations
      try {
        const result = await deps.execute(op.draft, async () => {
          op!.state = 'executing'
          // Persist BEFORE calling the sales RPC. A lost reply must never trigger another sale.
          await deps.store.saveOperation(op!)
        })
        op.state = 'completed'
        const alerts = await alertsFor(op.draft.items.map(i => i.product_id))
        return await finish({
          status: 'completed', operation_id: id,
          message: `Venta registrada correctamente (referencia ${result.saleId}).${alertText(alerts)}`,
          result: { reference: result.saleId, total: result.total, currency: op.draft.currency, items: op.draft.items, alerts }
        })
      } catch (error) {
        // A storage error after receiving the receipt must not report a failed sale.
        if (op.state === 'completed' && op.response?.status === 'completed') return op.response
        if (error instanceof SaleNotCommittedError) return cancel(error.message)
        // After dispatch, an error may be a lost RPC response rather than a rolled-back sale.
        if (op.state === 'executing') return finish(pending(id))
        return finish({ status: 'rejected', operation_id: id, message: 'No se pudo registrar la venta. No se envió al POS. Reintenta con otro request_id.' })
      }
    })
  } catch (error) {
    if (error instanceof AgentBusyError) return pending(id)
    throw error
  }
}
