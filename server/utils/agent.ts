import { createHash, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { createError, getHeader, getRequestURL, setHeader, type H3Event } from 'h3'
import { makeSalesAgent } from '../modules/agent/app/salesAgent'
import { makeSalePreparer } from '../modules/agent/app/prepareSale'
import { makeCatalogAnswerer } from '../modules/agent/app/catalogAnswers'
import { embeddingModelName, makeOpenAIEmbedder } from '../modules/agent/infra/openaiEmbeddings'
import { makeSealer, makeSellerSessions, SellerRejectedError, type ActiveSeller, type SellerSessions } from '../modules/agent/app/sellerSessions'
import { makeFileAgentStore } from '../modules/agent/infra/fileAgentStore'
import { makeFileSellerSessionStore } from '../modules/agent/infra/fileSellerSessionStore'
import { makeOpenAISalesInterpreter } from '../modules/agent/infra/openaiSalesInterpreter'
import { makeSupabaseAgentCatalog } from '../modules/agent/infra/supabaseAgentCatalog'
import { makeSupabaseSaleExecutor } from '../modules/agent/infra/supabaseSaleExecutor'
import { makeSupabaseSellerAuth } from '../modules/agent/infra/supabaseSellerAuth'

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

export const getAgentHandler = (event: H3Event, seller: ActiveSeller) => {
  const config = useRuntimeConfig(event)
  const key = String(config.openaiApiKey || '').trim()
  if (!key) throw createError({ statusCode: 503, statusMessage: 'Intérprete de ventas no configurado' })
  const embeddingModel = embeddingModelName(String(config.posAgentEmbeddingModel || ''))
  const catalog = makeSupabaseAgentCatalog({ embed: makeOpenAIEmbedder(key, embeddingModel), embeddingModel })
  const agent = makeSalesAgent({
    store: makeFileAgentStore(String(config.posAgentStorageDir)),
    interpret: makeOpenAISalesInterpreter(key, String(config.posAgentModel)),
    prepare: makeSalePreparer(catalog),
    answer: makeCatalogAnswerer(catalog),
    execute: makeSupabaseSaleExecutor(seller.authorize),
    stockLevels: ids => catalog.stockLevels(ids),
    reviewTtlMs: Number(config.posAgentReviewTtlHours || 48) * 60 * 60 * 1000
  })
  return (instruction: Parameters<typeof agent>[0]) => agent(instruction, { id: seller.user_id })
}
