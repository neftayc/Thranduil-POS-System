import { createError, defineEventHandler, setHeader } from 'h3'
import { getUserRole } from '../../../utils/auth'
import { getSellerSessions } from '../../../utils/agent'

// Seller sessions opened for Claude. Owner or manager, with their normal POS login.
export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  if (!['owner', 'manager'].includes(await getUserRole(event))) throw createError({ statusCode: 403, statusMessage: 'Acceso denegado' })
  return { sessions: await getSellerSessions(event).list() }
})
