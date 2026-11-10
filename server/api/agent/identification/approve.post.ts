import { createError, defineEventHandler, getHeader, getRequestIP, readBody, setHeader } from 'h3'
import { IdentificationError } from '../../../modules/agent/app/sellerSessions'
import { getSellerSessions } from '../../../utils/agent'

// Public endpoint used by /vincular. The password goes only to Supabase Auth and is never
// stored or logged. JSON-only (blocks cross-site form posts) and rate-limited per IP.
const WINDOW_MS = 10 * 60 * 1000
const MAX_PER_WINDOW = 10
const attempts = new Map<string, { count: number; since: number }>()

const allow = (ip: string) => {
  const now = Date.now()
  const entry = attempts.get(ip)
  if (!entry || now - entry.since > WINDOW_MS) {
    attempts.set(ip, { count: 1, since: now })
    return true
  }
  entry.count++
  return entry.count <= MAX_PER_WINDOW
}

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  if (!String(getHeader(event, 'content-type') || '').toLowerCase().startsWith('application/json')) {
    throw createError({ statusCode: 415, statusMessage: 'Se requiere application/json' })
  }
  if (!allow(getRequestIP(event) || 'unknown')) {
    throw createError({ statusCode: 429, statusMessage: 'Demasiados intentos. Espera unos minutos.' })
  }
  const body = await readBody(event).catch(() => null) as Record<string, unknown> | null
  const field = (name: string, max: number) => {
    const value = body?.[name]
    return typeof value === 'string' && value.length <= max ? value : ''
  }
  try {
    const seller = await getSellerSessions(event).approve(field('user_code', 16), field('email', 254), field('password', 256))
    return { ok: true, seller: { name: seller.name, role: seller.role }, expires_at: new Date(seller.expires_at).toISOString() }
  } catch (error) {
    if (error instanceof IdentificationError) throw createError({ statusCode: 400, statusMessage: error.message })
    if ((error as any)?.statusCode) throw error
    throw createError({ statusCode: 503, statusMessage: 'No se pudo completar la vinculación. Intenta de nuevo.' })
  }
})
