import { createError, defineEventHandler, readBody } from 'h3'
import { z } from 'zod'
import { getSellerSessions, getVerificationUrl, requireAgentCredential } from '../../../utils/agent'

// yachay-identification/1 — called ONLY by the connector (service credential).
const schema = z.discriminatedUnion('action', [
  z.object({ protocol: z.literal('yachay-identification/1'), action: z.literal('start') }).strict(),
  z.object({ protocol: z.literal('yachay-identification/1'), action: z.literal('status'), identification_id: z.string().min(1).max(512) }).strict()
])

export default defineEventHandler(async (event) => {
  requireAgentCredential(event)
  const parsed = schema.safeParse(await readBody(event).catch(() => null))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Contrato yachay-identification/1 inválido' })
  const sessions = getSellerSessions(event)
  if (parsed.data.action === 'start') return sessions.start(getVerificationUrl(event))
  return sessions.status(parsed.data.identification_id)
})
