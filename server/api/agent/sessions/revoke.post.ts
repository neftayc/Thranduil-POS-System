import { createError, defineEventHandler, readBody } from 'h3'
import { getUserRole } from '../../../utils/auth'
import { getSellerSessions } from '../../../utils/agent'

export default defineEventHandler(async (event) => {
  if (!['owner', 'manager'].includes(await getUserRole(event))) throw createError({ statusCode: 403, statusMessage: 'Acceso denegado' })
  const id = String((await readBody(event).catch(() => null))?.id || '')
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw createError({ statusCode: 400, statusMessage: 'Sesión inválida' })
  if (!await getSellerSessions(event).revoke(id)) throw createError({ statusCode: 404, statusMessage: 'Sesión no encontrada' })
  return { ok: true }
})
