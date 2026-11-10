import { createHash, timingSafeEqual } from 'node:crypto'
import { createError, getHeader, setHeader, type H3Event } from 'h3'
import { makeSalesAgent } from '../modules/agent/app/salesAgent'
import { makeSalePreparer } from '../modules/agent/app/prepareSale'
import { makeFileAgentStore } from '../modules/agent/infra/fileAgentStore'
import { makeOpenAISalesInterpreter } from '../modules/agent/infra/openaiSalesInterpreter'
import { makeSupabaseAgentCatalog } from '../modules/agent/infra/supabaseAgentCatalog'
import { makeSupabaseSaleExecutor } from '../modules/agent/infra/supabaseSaleExecutor'

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

export const getAgentHandler = (event: H3Event) => {
  const config = useRuntimeConfig(event)
  const key = String(config.openaiApiKey || '').trim()
  if (!key) throw createError({ statusCode: 503, statusMessage: 'Intérprete de ventas no configurado' })
  return makeSalesAgent({
    store: makeFileAgentStore(String(config.posAgentStorageDir)),
    interpret: makeOpenAISalesInterpreter(key, String(config.posAgentModel)),
    prepare: makeSalePreparer(makeSupabaseAgentCatalog()),
    execute: makeSupabaseSaleExecutor(() => String(config.posAgentSellerAccessToken || ''))
  })
}
