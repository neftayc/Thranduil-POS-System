import { createHash } from 'node:crypto'
import {
  AgentBusyError, AgentConflictError, SaleNotCommittedError,
  type AgentResponse, type Instruction, type Operation, type SalesAgentDependencies
} from '../contracts'

const normalize = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[.,!¡¿?]/g, '').trim().replace(/\s+/g, ' ')
const confirmations = new Set(['si', 'confirmo', 'confirmar', 'si confirmo', 'confirmar venta', 'confirmo la venta', 'si confirmo la venta'])
const cancellations = new Set(['no', 'cancelar', 'cancela', 'cancelar venta', 'cancela la venta'])
const pending = (id: string): AgentResponse => ({
  status: 'pending', operation_id: id,
  message: 'La operación está en proceso o su resultado está pendiente de conciliación. Reintenta con el mismo request_id; no envíes una venta nueva.'
})

export const makeSalesAgent = (deps: SalesAgentDependencies) => async (request: Instruction): Promise<AgentResponse> => {
  const id = request.operation_id || request.request_id
  const fingerprint = createHash('sha256').update(JSON.stringify([
    request.protocol, request.type, request.operation_id || null, request.input.text, request.input.locale || 'es-PE'
  ])).digest('hex')
  const existing = await deps.store.getRequest(request.request_id)
  if (existing) {
    if (existing.fingerprint !== fingerprint) throw new AgentConflictError('request_id ya utilizado con otro contenido')
    if (existing.response) return existing.response
    const interrupted = await deps.store.getOperation(existing.operation_id)
    return interrupted?.state === 'completed' ? interrupted.response! : pending(existing.operation_id)
  }
  try {
    return await deps.store.exclusive(async () => {
      const duplicate = await deps.store.getRequest(request.request_id)
      if (duplicate) {
        if (duplicate.fingerprint !== fingerprint) throw new AgentConflictError('request_id ya utilizado con otro contenido')
        return duplicate.response || pending(duplicate.operation_id)
      }
      let op = await deps.store.getOperation(id)
      if (!op && request.type === 'follow_up') {
        return { status: 'rejected', operation_id: id, message: 'Operación no encontrada. Envía una nueva instrucción.' }
      }
      if (!op) {
        op = { id, state: 'preparing', messages: [], candidates: [], expires_at: Date.now() + 60 * 60 * 1000 }
      }
      await deps.store.saveRequest(request.request_id, { fingerprint, operation_id: id })
      const finish = async (response: AgentResponse) => {
        op!.response = response
        await deps.store.saveOperation(op!)
        await deps.store.saveRequest(request.request_id, { fingerprint, operation_id: id, response })
        return response
      }
      if (op.state === 'completed' || op.state === 'cancelled') return finish(op.response!)
      if (op.state === 'executing') return finish(pending(id))
      if (op.expires_at < Date.now()) {
        return finish({ status: 'rejected', operation_id: id, message: 'El borrador venció. Envía una nueva instrucción para consultar precios y stock actuales.' })
      }
      const answer = normalize(request.input.text)
      if (request.type === 'follow_up' && cancellations.has(answer)) {
        op.state = 'cancelled'
        return finish({ status: 'rejected', operation_id: id, message: 'Operación cancelada. No se registró una venta.' })
      }
      if (request.type === 'follow_up' && op.state === 'confirmation' && confirmations.has(answer)) {
        try {
          // Reprice before committing; changed prices require a fresh confirmation.
          const prepared = await deps.prepare(op.interpretation!, op.candidates)
          if (!prepared.draft) {
            op.state = 'clarification'
            op.candidates = prepared.candidates
            delete op.draft
            return finish({ status: 'needs_clarification', operation_id: id, message: prepared.question || 'Revisa los datos de la venta.' })
          }
          if (JSON.stringify(prepared.draft) !== JSON.stringify(op.draft)) {
            op.draft = prepared.draft
            return finish({ status: 'requires_confirmation', operation_id: id, message: 'El pedido o sus precios cambiaron. Confirma nuevamente el detalle actualizado.', result: { draft: op.draft } })
          }
          const result = await deps.execute(op.draft!, async () => {
            op!.state = 'executing'
            // Persist BEFORE calling the sales RPC. A lost reply must never trigger another sale.
            await deps.store.saveOperation(op!)
          })
          op.state = 'completed'
          return await finish({ status: 'completed', operation_id: id, message: 'Venta registrada correctamente.', result: { reference: result.saleId, total: result.total, currency: op.draft!.currency, items: op.draft!.items } })
        } catch (error) {
          // A storage error after receiving the receipt must not report a failed sale.
          // The persisted executing marker still prevents a second RPC call.
          if (op.state === 'completed' && op.response?.status === 'completed') return op.response
          if (error instanceof SaleNotCommittedError) {
            op.state = 'confirmation'
            return finish({ status: 'rejected', operation_id: id, message: error.message, result: { draft: op.draft } })
          }
          // After dispatch, an error may be a lost RPC response rather than a rolled-back sale.
          if (op.state === 'executing') return finish(pending(id))
          return finish({ status: 'rejected', operation_id: id, message: 'No se pudo validar la ejecución. No se envió una venta. Revisa la configuración o reintenta con otro request_id en esta operación.' })
        }
      }
      op.messages.push(request.input.text)
      if (op.messages.length > 20) {
        return finish({ status: 'rejected', operation_id: id, message: 'Se alcanzó el límite de aclaraciones. Inicia un pedido nuevo.' })
      }
      try {
        const parsed = await deps.interpret(op.messages, op)
        op.interpretation = parsed
        if (parsed.intent === 'cancel') {
          op.state = 'cancelled'
          return finish({ status: 'rejected', operation_id: id, message: 'Operación cancelada. No se registró una venta.' })
        }
        if (parsed.intent !== 'sale') {
          return finish({ status: 'rejected', operation_id: id, message: 'Esta integración permite preparar y confirmar ventas. Indica qué productos deseas vender y en qué cantidad.' })
        }
        const prepared = await deps.prepare(parsed, op.candidates)
        op.candidates = prepared.candidates
        if (!prepared.draft) {
          op.state = 'clarification'
          delete op.draft
          return finish({ status: 'needs_clarification', operation_id: id, message: prepared.question || 'Completa los datos del pedido.', result: { candidates: prepared.candidates } })
        }
        op.state = 'confirmation'
        op.draft = prepared.draft
        return finish({ status: 'requires_confirmation', operation_id: id, message: `Confirma la venta por ${op.draft.currency} ${op.draft.total.toFixed(2)} revisando productos, cantidades y forma de pago.`, result: { draft: op.draft } })
      } catch {
        return finish({ status: 'rejected', operation_id: id, message: 'No se pudo preparar el pedido. No se registró una venta. Comprueba el servicio de interpretación y el acceso al catálogo; reintenta con otro request_id en esta operación.' })
      }
    })
  } catch (error) {
    if (error instanceof AgentBusyError) return pending(id)
    throw error
  }
}
