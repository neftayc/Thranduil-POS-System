import { join } from 'node:path'
import { createError, setHeader, type H3Event } from 'h3'
import { getUserIdFromAccessToken, getUserRole, requireAccessToken } from './auth'
import { getSupabaseUserClient } from './supabase'
import { getAgentModes } from './agent'
import { makeFileAgentStore } from '../modules/agent/infra/fileAgentStore'
import { makeSupabaseAgentCatalog } from '../modules/agent/infra/supabaseAgentCatalog'
import { makeSupabaseSaleExecutor } from '../modules/agent/infra/supabaseSaleExecutor'
import { memoizeByKey } from '../modules/agent/app/runtimeModes'
import {
  makeReviewDesk, ReviewConflictError, ReviewInvalidError, ReviewNotFoundError, ReviewPendingError, type Reviewer
} from '../modules/agent/app/reviewDesk'

export const REVIEWER_ROLES = new Set(['owner', 'manager'])

/** Owner or manager with their normal POS login (Supabase Auth, RPC user_role). */
export const requireReviewer = async (event: H3Event): Promise<Reviewer & { accessToken: string }> => {
  setHeader(event, 'Cache-Control', 'no-store')
  const role = await getUserRole(event)
  if (!REVIEWER_ROLES.has(role)) throw createError({ statusCode: 403, statusMessage: 'Solo el propietario o el encargado pueden revisar ventas por confirmar.' })
  return { id: await getUserIdFromAccessToken(event), role, accessToken: await requireAccessToken(event) }
}

// Read-only catalog (no embeddings, no background indexing): only facts to verify the resolution.
const catalogFor = memoizeByKey(() => makeSupabaseAgentCatalog())

/**
 * Same store as the sales agent (dry-run keeps its own folder) and the same executor (create_sale),
 * but registering with the REVIEWER's token: a price ≠ list needs owner/manager in create_sale.
 */
export const getReviewDesk = (event: H3Event, accessToken: string) => {
  const config = useRuntimeConfig(event)
  const { dryRun } = getAgentModes(event)
  const dir = String(config.posAgentStorageDir)
  return {
    dryRun,
    ttlHours: Number(config.posAgentReviewTtlHours || 48),
    desk: makeReviewDesk({
      store: makeFileAgentStore(dryRun ? join(dir, 'dry-run') : dir),
      catalog: catalogFor('review'),
      dryRun,
      reviewTtlMs: Number(config.posAgentReviewTtlHours || 48) * 60 * 60 * 1000,
      // In dry-run the desk never calls execute; this is a second barrier.
      execute: dryRun
        ? async () => { throw new Error('Modo de solo validación (POS_AGENT_DRY_RUN): no se registran ventas.') }
        : makeSupabaseSaleExecutor(async () => accessToken, (token, args) => getSupabaseUserClient(token).rpc('create_sale', args) as any)
    })
  }
}

/** Names of the sellers (profiles.full_name), read with the reviewer's own token. */
export const sellerNames = async (accessToken: string, ids: string[]) => {
  const names = new Map<string, string>()
  if (!ids.length) return names
  try {
    const { data } = await getSupabaseUserClient(accessToken).from('profiles').select('id, full_name').in('id', [...new Set(ids)])
    for (const row of (data || []) as Array<{ id: string; full_name: string | null }>) if (row.full_name) names.set(row.id, row.full_name)
  } catch {}
  return names
}

/** Maps the desk's errors to HTTP answers with a Spanish message. */
export const reviewHttpError = (error: unknown) => {
  if (error instanceof ReviewNotFoundError) return createError({ statusCode: 404, statusMessage: error.message })
  if (error instanceof ReviewInvalidError) return createError({ statusCode: 422, statusMessage: 'La venta no pasó la verificación.', data: { errors: error.errors } })
  if (error instanceof ReviewPendingError) return createError({ statusCode: 409, statusMessage: error.message, data: { pending: true } })
  if (error instanceof ReviewConflictError) return createError({ statusCode: 409, statusMessage: error.message })
  if ((error as any)?.statusCode) return error as any
  console.error('[revisión de ventas]', error)
  return createError({ statusCode: 500, statusMessage: 'No se pudo completar la revisión. No se registró nada nuevo.' })
}

export const isOperationId = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
