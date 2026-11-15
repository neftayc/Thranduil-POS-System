import type { AgentStore, PriceReview } from '../contracts'

export type PendingPriceReview = PriceReview & { operation_id: string; expires_at: string }

/**
 * "Ventas por confirmar" with a dictated price different from the list price (NOT registered),
 * for the reviewer (owner/manager) to approve at that price — the future review screen. Only live
 * ones: when the review expires (POS_AGENT_REVIEW_TTL_HOURS) its reservation is released and it
 * leaves this list; the operation file (draft, reasons, prices) is kept for audit.
 */
export const listPendingPriceReviews = async (store: AgentStore, now = Date.now()): Promise<PendingPriceReview[]> =>
  (await store.listOperations())
    .filter(op => op.state === 'review' && op.expires_at > now && op.price_review?.status === 'pending')
    .map(op => ({ ...op.price_review!, operation_id: op.id, expires_at: new Date(op.expires_at).toISOString() }))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
