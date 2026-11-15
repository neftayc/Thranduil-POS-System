import type { Operation } from '../contracts'

/**
 * Base units held by live (not expired) ventas por confirmar, per product.
 * Same rule as process 2's `reservedTotals` (salesAgent.ts): state 'review' and not expired.
 * Used by catalog answers so «¿cuántos quedan?» says what is really available.
 */
export const reservedFromOperations = (operations: Operation[], now: number, excludeId: string | null = null) => {
  const totals = new Map<string, number>()
  for (const op of operations) {
    if (op.id === excludeId || op.state !== 'review' || op.expires_at <= now) continue
    for (const r of op.reservations || []) totals.set(r.product_id, (totals.get(r.product_id) || 0) + r.qty)
  }
  return totals
}
