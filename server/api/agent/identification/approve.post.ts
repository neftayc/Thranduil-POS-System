import { createError, defineEventHandler, getHeader, getRequestIP, readBody, setHeader } from 'h3'
import { IdentificationError } from '../../../modules/agent/app/sellerSessions'
import { getSellerSessions } from '../../../utils/agent'

// Public endpoint used by /vincular. The password goes only to Supabase Auth and is never
// stored or logged. JSON-only (blocks cross-site form posts). Failed attempts are limited per
// code (5, atomic), per email and per IP inside sellerSessions; successful ones never count.
export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  if (!String(getHeader(event, 'content-type') || '').toLowerCase().startsWith('application/json')) {
    throw createError({ statusCode: 415, statusMessage: 'Se requiere application/json' })
  }
  const body = await readBody(event).catch(() => null) as Record<string, unknown> | null
  const field = (name: string, max: number) => {
    const value = body?.[name]
    return typeof value === 'string' && value.length <= max ? value : ''
  }
  try {
    const seller = await getSellerSessions(event).approve(field('user_code', 16), field('email', 254), field('password', 256), getRequestIP(event) || 'desconocida')
    // match_code goes only to the seller's page; it must be typed in the Claude chat.
    return { ok: true, seller: { name: seller.name, role: seller.role }, expires_at: new Date(seller.expires_at).toISOString(), match_code: seller.match_code }
  } catch (error) {
    if (error instanceof IdentificationError) throw createError({ statusCode: 400, statusMessage: error.message })
    if ((error as any)?.statusCode) throw error
    throw createError({ statusCode: 503, statusMessage: 'No se pudo completar la vinculación. Intenta de nuevo.' })
  }
})
