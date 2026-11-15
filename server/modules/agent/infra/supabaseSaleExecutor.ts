import { SaleNotCommittedError, SaleRejectedByPosError, type SaleDraft } from '../contracts'

type RpcError = { message?: string; code?: string } | null
/** Calls create_sale with the seller's own token (wired in server/utils/agent.ts). */
export type RpcCall = (token: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: RpcError }>

/**
 * An error WITH a code is an answer from PostgREST/Postgres (SQLSTATE such as P0001, or PGRSTxxx):
 * create_sale runs in one transaction, so nothing was registered. An error WITHOUT a code is a
 * transport failure (fetch failed, timeout): the sale may or may not exist → indeterminate.
 */
export const isDefinitiveRpcError = (error: RpcError) => Boolean(error && typeof error.code === 'string' && error.code.trim())

/**
 * Registers the sale AS the identified seller: `authorize` re-validates the seller session
 * (not revoked, user active, valid role) and returns that seller's own access token, so the
 * create_sale RPC records auth.uid() = seller. No service key, no shared seller token.
 */
export const DEFAULT_RPC_TIMEOUT_MS = 20_000
export type ExecutorOptions = {
  /** create_sale timeout. A timeout AFTER sending is indeterminate (pending), never retried. */
  timeoutMs?: number
  /** Server-side log for database details; they are never sent to the chat. */
  log?: (message: string, detail: Record<string, unknown>) => void
}

export const makeSupabaseSaleExecutor = (authorize: () => Promise<string>, rpc: RpcCall, options: ExecutorOptions = {}) => async (draft: SaleDraft, beforeCommit: () => Promise<void>) => {
  const log = options.log || ((message, detail) => console.error(message, detail))
  let token: string
  try {
    token = await authorize()
  } catch (error) {
    const reason = error instanceof Error && error.message ? error.message : 'La sesión del vendedor no es válida.'
    throw new SaleNotCommittedError(`${reason} No se registró una venta.`)
  }
  await beforeCommit()
  // From here on, only a definitive database answer may be reported as "not registered".
  // The orchestrator never retries this call.
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('create_sale sin respuesta (timeout)')), options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS)
  })
  let answer: Awaited<ReturnType<RpcCall>>
  try {
    answer = await Promise.race([rpc(token, {
      p_customer_id: draft.customer_id,
      p_payment_method: draft.payment_method,
      // A price different from the list price needs manual_discount_reason (owner/manager only, enforced by create_sale).
      p_items: draft.items.map(item => ({
        product_id: item.product_id, qty: item.qty, unit_name: item.unit_name, price_unit: item.price_unit,
        ...(item.manual_reason ? { manual_discount_reason: item.manual_reason } : {})
      }))
    }), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
  const { data, error } = answer
  if (error) {
    if (isDefinitiveRpcError(error)) {
      // The detail (e.g. product names) stays in the server log; the chat only gets the code.
      const code = String(error.code).trim().slice(0, 12)
      log('[agente de ventas] create_sale rechazó la venta', { code, message: error.message })
      throw new SaleRejectedByPosError(code)
    }
    throw new Error('Respuesta de create_sale perdida')
  }
  if (!data) throw new Error('La base de datos no devolvió el identificador de venta')
  return { saleId: String(data), total: draft.total }
}
