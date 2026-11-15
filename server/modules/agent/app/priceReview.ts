import type { AgentStore, PriceReview } from '../contracts'

export type PendingPriceReview = PriceReview & { operation_id: string; simulated: boolean }

/**
 * Sales registered with a dictated price different from the list price, still to be validated
 * (for the noon / closing review). Dry-run records live in their own store and are flagged.
 */
export const listPendingPriceReviews = async (store: AgentStore): Promise<PendingPriceReview[]> =>
  (await store.listOperations())
    .filter(op => op.price_review?.status === 'pending' && (op.state === 'completed' || op.state === 'simulated'))
    .map(op => ({ ...op.price_review!, operation_id: op.id, simulated: op.state === 'simulated' }))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
