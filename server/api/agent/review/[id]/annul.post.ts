import { createError, defineEventHandler, getRouterParam, readBody } from 'h3'
import { getReviewDesk, isOperationId, requireReviewer, reviewHttpError } from '../../../../utils/agentReview'

// Annuls a venta por confirmar: releases its reservation; the operation file stays for audit.
export default defineEventHandler(async (event) => {
  const reviewer = await requireReviewer(event)
  const id = getRouterParam(event, 'id')
  if (!isOperationId(id)) throw createError({ statusCode: 404, statusMessage: 'Venta por confirmar no encontrada.' })
  const body = (await readBody(event)) || {}
  const { desk } = getReviewDesk(event, reviewer.accessToken)
  try {
    return await desk.annul(id!, { version: String(body.version || ''), note: typeof body.note === 'string' ? body.note : undefined }, { id: reviewer.id, role: reviewer.role })
  } catch (error) {
    throw reviewHttpError(error)
  }
})
