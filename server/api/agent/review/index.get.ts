import { defineEventHandler } from 'h3'
import { getReviewDesk, requireReviewer, reviewHttpError, sellerNames } from '../../../utils/agentReview'

// Live ventas por confirmar left by the voice sales agent. Owner or manager.
export default defineEventHandler(async (event) => {
  const reviewer = await requireReviewer(event)
  const { desk, dryRun, ttlHours } = getReviewDesk(event, reviewer.accessToken)
  try {
    const cases = await desk.list()
    const [names, paymentMethods] = await Promise.all([sellerNames(reviewer.accessToken, cases.map(c => c.seller_id)), desk.paymentMethods()])
    return { dry_run: dryRun, ttl_hours: ttlHours, payment_methods: paymentMethods, cases: cases.map(c => ({ ...c, seller_name: names.get(c.seller_id) || null })) }
  } catch (error) {
    throw reviewHttpError(error)
  }
})
