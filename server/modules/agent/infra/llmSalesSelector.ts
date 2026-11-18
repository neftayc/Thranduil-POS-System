import type { AgentStore } from '../contracts'
import { reservedFromOperations } from '../app/reservations'
import { makeSelectorBuildDraft, type CatalogAnswerer, type SelectorCatalog } from '../app/salesSelector'
import { makeOpenAIReviewerModel, makeOpenAISelectorModel } from './openaiSalesSelector'
import { makeSalesReviewer } from '../app/salesReviewer'
import { makeSupabaseSelectorCatalog } from './supabaseSelectorCatalog'

/** One selector catalog per process and store (its memory cache is shared by every request). */
const catalogs = new Map<string, () => Promise<SelectorCatalog>>()

/**
 * Step 2 with POS_AGENT_SELECTOR=llm: the sales selector agent wired for process 2's
 * `buildDraft(messages, previous)`. READ-ONLY catalog (stock minus the reservations of the same
 * store the registrar uses); model = POS_AGENT_SELECTOR_MODEL.
 */
export const makeLlmSalesSelector = (options: { apiKey: string; model: string; store: AgentStore; storeKey: string; answer?: CatalogAnswerer }) => {
  let catalog = catalogs.get(options.storeKey)
  if (!catalog) {
    catalog = makeSupabaseSelectorCatalog({ reserved: async () => reservedFromOperations(await options.store.listOperations(), Date.now()) })
    catalogs.set(options.storeKey, catalog)
  }
  return makeSelectorBuildDraft({
    model: makeOpenAISelectorModel(options.apiKey, options.model || 'gpt-5.4'),
    // Second AI pass (owner: «no omitir nada; si es incoherencia, preguntar»).
    reviewer: makeSalesReviewer(makeOpenAIReviewerModel(options.apiKey, options.model || 'gpt-5.4')),
    catalog,
    answer: options.answer
  })
}
