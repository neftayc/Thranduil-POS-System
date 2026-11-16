import { defineEventHandler, getQuery } from 'h3'
import { getReviewDesk, requireReviewer, reviewHttpError, sellerNames } from '../../../utils/agentReview'

// Ventas por confirmar left by the voice sales agent. ?filter=pending (default) | expired | all. Owner or manager.
export default defineEventHandler(async (event) => {
  const reviewer = await requireReviewer(event)
  const { desk, dryRun, ttlHours } = getReviewDesk(event, reviewer.accessToken)
  try {
    const raw = String(getQuery(event).filter || 'pending')
    const filter = raw === 'expired' || raw === 'all' ? raw : 'pending'
    const cases = await desk.list(filter)
    const [names, paymentMethods] = await Promise.all([sellerNames(reviewer.accessToken, cases.map(c => c.seller_id)), desk.paymentMethods()])
    return { dry_run: dryRun, filter, ttl_hours: ttlHours, payment_methods: paymentMethods, cases: cases.map(c => ({ ...c, seller_name: names.get(c.seller_id) || null })) }
  } catch (error) {
    throw reviewHttpError(error)
  }
})
