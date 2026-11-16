import { createError, defineEventHandler, getRouterParam, readBody } from 'h3'
import { getReviewDesk, isOperationId, requireReviewer, reviewHttpError } from '../../../../utils/agentReview'

// Verifies the reviewer's resolution with live facts (price, stock, payment). Registers nothing.
export default defineEventHandler(async (event) => {
  const reviewer = await requireReviewer(event)
  const id = getRouterParam(event, 'id')
  if (!isOperationId(id)) throw createError({ statusCode: 404, statusMessage: 'Venta por confirmar no encontrada.' })
  const body = (await readBody(event)) || {}
  const { desk } = getReviewDesk(event, reviewer.accessToken)
  try {
    return await desk.preview(id!, { lines: Array.isArray(body.lines) ? body.lines : [], payment_method: String(body.payment_method || '') })
  } catch (error) {
    throw reviewHttpError(error)
  }
})
