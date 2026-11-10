import { createError, defineEventHandler, getHeader, getRequestIP, readBody, setHeader } from 'h3'
import { IdentificationError } from '../../../modules/agent/app/sellerSessions'
import { getSellerSessions } from '../../../utils/agent'

// Public, for /vincular: shows WHEN the pending request was created so the seller can detect a
// code that is not his/hers (device-flow phishing). Unknown codes count as failures per IP.
export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  if (!String(getHeader(event, 'content-type') || '').toLowerCase().startsWith('application/json')) {
    throw createError({ statusCode: 415, statusMessage: 'Se requiere application/json' })
  }
  const code = (await readBody(event).catch(() => null) as Record<string, unknown> | null)?.user_code
  try {
    const info = await getSellerSessions(event).lookup(typeof code === 'string' ? code.slice(0, 16) : '', getRequestIP(event) || 'desconocida')
    return { requested_at: new Date(info.requested_at).toISOString(), expires_at: new Date(info.expires_at).toISOString() }
  } catch (error) {
    if (error instanceof IdentificationError) throw createError({ statusCode: 400, statusMessage: error.message })
    throw createError({ statusCode: 503, statusMessage: 'No se pudo consultar el código. Intenta de nuevo.' })
  }
})
