import { createError, defineEventHandler, getHeader, readRawBody } from 'h3'
import { requireAgentCredential, getAgentHandler } from '../../utils/agent'
import { AgentConflictError, instructionSchema } from '../../modules/agent/contracts'

export default defineEventHandler(async (event) => {
  requireAgentCredential(event)
  if (!String(getHeader(event, 'content-type') || '').toLowerCase().startsWith('application/json')) {
    throw createError({ statusCode: 415, statusMessage: 'Se requiere application/json' })
  }
  if (Number(getHeader(event, 'content-length') || 0) > 16000) {
    throw createError({ statusCode: 413, statusMessage: 'Petición demasiado grande' })
  }
  const raw = await readRawBody(event)
  if (!raw || Buffer.byteLength(raw, 'utf8') > 16000) throw createError({ statusCode: 413, statusMessage: 'Cuerpo vacío o demasiado grande' })
  let body: unknown
  try { body = JSON.parse(raw) }
  catch { throw createError({ statusCode: 400, statusMessage: 'JSON inválido' }) }
  const parsed = instructionSchema.safeParse(body)
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Contrato yachay-agent/1 inválido', data: { issues: parsed.error.issues.map(issue => ({ path: issue.path, message: issue.message })) } })
  try {
    // Yachay has a 12-second timeout. Local work continues and persists its result;
    // a repeat of the same UUID reads that result instead of launching another task.
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        getAgentHandler(event)(parsed.data),
        new Promise(resolve => {
          timer = setTimeout(() => resolve({
            status: 'pending', operation_id: parsed.data.operation_id || parsed.data.request_id,
            message: 'El pedido se está procesando. Reintenta el mismo mensaje con el mismo request_id para obtener el resultado.'
          }), 8000)
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  } catch (error) {
    if (error instanceof AgentConflictError) throw createError({ statusCode: 409, statusMessage: error.message })
    if ((error as any)?.statusCode) throw error
    throw createError({ statusCode: 503, statusMessage: 'Agente no disponible; conserva el request_id para reintentar' })
  }
})
