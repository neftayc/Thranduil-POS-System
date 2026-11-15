import { createHash, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { createError, getHeader, getRequestURL, setHeader, type H3Event } from 'h3'
import { makeSalesAgent } from '../modules/agent/app/salesAgent'
import { makeDraftValidator } from '../modules/agent/app/validateDraft'
import { makeHybridDraftBuilder } from '../modules/agent/app/draftBuilder'
import { makeSealer, makeSellerSessions, SellerRejectedError, type ActiveSeller, type SellerSessions } from '../modules/agent/app/sellerSessions'
import { makeFileAgentStore } from '../modules/agent/infra/fileAgentStore'
import { makeFileSellerSessionStore } from '../modules/agent/infra/fileSellerSessionStore'
import { makeOpenAIOrderInterpreter } from '../modules/agent/infra/openaiOrderInterpreter'
import { makeOpenAIProductSelector } from '../modules/agent/infra/openaiProductSelector'
import { embeddingModelName, makeOpenAIEmbedder } from '../modules/agent/infra/openaiEmbeddings'
import { makeSupabaseAgentCatalog, searchAutoindexIntervalMs } from '../modules/agent/infra/supabaseAgentCatalog'
import { makeSupabaseSaleExecutor } from '../modules/agent/infra/supabaseSaleExecutor'
import { makeSupabaseSellerAuth } from '../modules/agent/infra/supabaseSellerAuth'
import { getSupabaseUserClient } from './supabase'
import { SaleNotCommittedError } from '../modules/agent/contracts'
import { memoizeByKey, resolveAgentModes } from '../modules/agent/app/runtimeModes'

/** Dry-run / autoindex resolved at RUNTIME from every source (see runtimeModes.ts). */
export const getAgentModes = (event?: H3Event) => resolveAgentModes(useRuntimeConfig(event) as any)

export const SELLER_SESSION_HEADER = 'x-yachay-session'

export const requireAgentCredential = (event: H3Event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const expected = String(useRuntimeConfig(event).posAgentToken || '')
  if (expected.length < 32) throw createError({ statusCode: 503, statusMessage: 'Integración MCP no configurada' })
  const supplied = getHeader(event, 'authorization') || ''
  const digest = (value: string) => createHash('sha256').update(value).digest()
  if (!timingSafeEqual(digest(supplied), digest(`Bearer ${expected}`))) {
    throw createError({ statusCode: 401, statusMessage: 'Credencial del conector inválida' })
  }
}

let sessions: { key: string; dir: string; value: SellerSessions } | null = null

/** Seller sessions (one instance per process: refresh-token rotation is serialized in memory). */
export const getSellerSessions = (event: H3Event) => {
  const config = useRuntimeConfig(event)
  const key = String(config.posAgentSessionKey || '')
  if (key.length < 32) throw createError({ statusCode: 503, statusMessage: 'Identificación de vendedores no configurada (POS_AGENT_SESSION_KEY)' })
  const dir = join(String(config.posAgentStorageDir), 'sessions')
  if (!sessions || sessions.key !== key || sessions.dir !== dir) {
    sessions = { key, dir, value: makeSellerSessions({ store: makeFileSellerSessionStore(dir), auth: makeSupabaseSellerAuth(), sealer: makeSealer(key) }) }
  }
  return sessions.value
}

/** Link shown to the seller: this POS's own /vincular page (configurable for a public URL). */
export const getVerificationUrl = (event: H3Event) => {
  const configured = String(useRuntimeConfig(event).posAgentPublicUrl || '').replace(/\/+$/, '')
  return `${configured || getRequestURL(event).origin}/vincular`
}

/** Validates X-Yachay-Session; 403 with a Spanish message (no secrets) when not acceptable. */
export const requireSeller = async (event: H3Event): Promise<ActiveSeller> => {
  const ref = String(getHeader(event, SELLER_SESSION_HEADER) || '')
  if (!ref) throw createError({ statusCode: 403, statusMessage: 'Falta identificar al vendedor. Selecciona el sistema y aprueba el código en el POS.' })
  try {
    return await getSellerSessions(event).resolve(ref)
  } catch (error) {
    if (error instanceof SellerRejectedError) throw createError({ statusCode: 403, statusMessage: error.message })
    if ((error as any)?.statusCode) throw error
    throw createError({ statusCode: 503, statusMessage: 'No se pudo validar al vendedor. Reintenta en unos segundos.' })
  }
}

type CatalogConfig = { apiKey: string; embeddingModel: string; autoindex: boolean; dryRun: boolean }
let catalogConfig: CatalogConfig
/**
 * One catalog per process (and per configuration): its caches and the background-indexing
 * throttle are shared by every request instead of starting over on each one.
 */
const catalogFor = memoizeByKey(() => makeSupabaseAgentCatalog({
  embed: makeOpenAIEmbedder(catalogConfig.apiKey, catalogConfig.embeddingModel), embeddingModel: catalogConfig.embeddingModel,
  // Read-only by default: background indexing only with POS_AGENT_SEARCH_AUTOINDEX=1, never in dry-run.
  backgroundIndexIntervalMs: searchAutoindexIntervalMs({ autoindex: catalogConfig.autoindex, dryRun: catalogConfig.dryRun })
}))
const getCatalog = (apiKey: string, embeddingModel: string, autoindex: boolean, dryRun: boolean) => {
  catalogConfig = { apiKey, embeddingModel, autoindex, dryRun }
  return catalogFor(createHash('sha256').update(JSON.stringify([apiKey, embeddingModel, autoindex, dryRun])).digest('hex'))
}

export const getAgentHandler = (event: H3Event, seller: ActiveSeller) => {
  const config = useRuntimeConfig(event)
  const key = String(config.openaiApiKey || '').trim()
  if (!key) throw createError({ statusCode: 503, statusMessage: 'Intérprete de ventas no configurado' })
  const embeddingModel = embeddingModelName(String(config.posAgentEmbeddingModel || ''))
  const { dryRun, autoindex } = getAgentModes(event)
  const catalog = getCatalog(key, embeddingModel, autoindex, dryRun)
  const agent = makeSalesAgent({
    // Dry-run keeps its own idempotency records and simulated reservations, apart from the real ones.
    store: makeFileAgentStore(dryRun ? join(String(config.posAgentStorageDir), 'dry-run') : String(config.posAgentStorageDir)),
    // Agent 1 (AI): interpretation + hybrid search (vectors + text + exact attributes) → sale-draft/1.
    // Catalog questions are answered by process 2 as information (completed, kind catalog_answer), never as a sale.
    // The context selector (same model) only orders equally compatible options; it never invents or upgrades.
    buildDraft: makeHybridDraftBuilder(makeOpenAIOrderInterpreter(key, String(config.posAgentModel)), catalog, {
      answerCatalogQuestions: true, selector: makeOpenAIProductSelector(key, String(config.posAgentModel))
    }),
    // Process 2 (deterministic).
    validate: makeDraftValidator(catalog),
    // Second barrier: in dry-run the executor cannot reach create_sale even if called.
    execute: dryRun
      ? async () => { throw new SaleNotCommittedError('Modo de solo validación (POS_AGENT_DRY_RUN): no se registran ventas.') }
      : makeSupabaseSaleExecutor(seller.authorize, (token, args) => getSupabaseUserClient(token).rpc('create_sale', args) as any),
    dryRun,
    stockLevels: ids => catalog.stockLevels(ids),
    reviewTtlMs: Number(config.posAgentReviewTtlHours || 48) * 60 * 60 * 1000
  })
  return (instruction: Parameters<typeof agent>[0]) => agent(instruction, { id: seller.user_id })
}
