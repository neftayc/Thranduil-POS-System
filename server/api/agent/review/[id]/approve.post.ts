import { createError, defineEventHandler, getRouterParam, readBody } from 'h3'
import { getReviewDesk, isOperationId, requireReviewer, reviewHttpError } from '../../../../utils/agentReview'

// Approves a venta por confirmar: re-verifies facts and registers it with create_sale (dry-run: simulates).
// Idempotent by operation: approving again returns the same outcome, never a second sale.
export default defineEventHandler(async (event) => {
  const reviewer = await requireReviewer(event)
  const id = getRouterParam(event, 'id')
  if (!isOperationId(id)) throw createError({ statusCode: 404, statusMessage: 'Venta por confirmar no encontrada.' })
  const body = (await readBody(event)) || {}
  const { desk } = getReviewDesk(event, reviewer.accessToken)
  try {
    return await desk.approve(id!, {
      version: String(body.version || ''),
      lines: Array.isArray(body.lines) ? body.lines : [],
      payment_method: String(body.payment_method || ''),
      note: typeof body.note === 'string' ? body.note : undefined,
      accept_changes: typeof body.accept_changes === 'string' ? body.accept_changes : undefined
    }, { id: reviewer.id, role: reviewer.role })
  } catch (error) {
    throw reviewHttpError(error)
  }
})
