import { saleDraftSchema, type Product, type SaleDraftV1 } from '../contracts'
import type { SaleProposal } from './agent1Contracts'
import { makeCatalogAnswerer } from './catalogAnswers'
import { makeSalePreparer, type AgentCatalog } from './prepareSale'
import type { OrderInterpreter } from '../infra/openaiOrderInterpreter'

export type CatalogAnswer = { kind: 'catalog_answer'; message: string; result: Record<string, unknown> }

const MAX = { items: 20, doubts: 10, candidates: 8, query: 500, source: 5000 }

/**
 * Converts agent 1's proposal into the contract with process 2 (sale-draft/1).
 * A line is `high` only with a single product and no doubt; anything else carries coded doubts.
 * `price_unit` is the price agent 1 read from resolve_sale_item_pricing (process 2 recomputes it).
 */
export const toSaleDraft = (proposal: SaleProposal, sourceText: string, intent: SaleDraftV1['intent'] = 'sale'): SaleDraftV1 => {
  const items = proposal.items.slice(0, MAX.items).map(line => {
    const high = line.confidence === 'high' && line.product_id !== null && !line.doubts.length
    return {
      product_id: line.product_id,
      candidates: line.alternatives.map(a => a.product_id).filter(id => id !== line.product_id).slice(0, MAX.candidates),
      quantity: line.qty,
      unit: line.unit,
      price_unit: line.price_unit,
      confidence: high ? 'high' as const : line.confidence === 'high' ? 'medium' as const : line.confidence,
      doubts: line.doubts.slice(0, MAX.doubts),
      query: line.query.slice(0, MAX.query)
    }
  })
  return saleDraftSchema.parse({
    version: 'sale-draft/1',
    intent,
    items,
    payment_method: proposal.payment_method,
    customer_id: proposal.customer_id,
    doubts: proposal.order_doubts.slice(0, MAX.doubts),
    source_text: sourceText.slice(0, MAX.source)
  })
}

const emptyDraft = (intent: SaleDraftV1['intent'], sourceText: string): SaleDraftV1 => ({
  version: 'sale-draft/1', intent, items: [], payment_method: null, customer_id: null, doubts: [], source_text: sourceText.slice(0, MAX.source)
})

/**
 * AGENT 1: `buildDraft(messages, previous)` for process 2.
 * interpret (OpenAI) → hybrid search + exact attributes → live price/stock → sale-draft/1.
 * Product IDs only come from real catalog candidates; nothing is registered here.
 *
 * Catalog questions: with `answerCatalogQuestions` the builder returns a `CatalogAnswer`
 * (process 2 must answer it without selling). Without it they are `intent: 'unsupported'`.
 */
export const makeHybridDraftBuilder = (
  interpret: OrderInterpreter,
  catalog: AgentCatalog,
  options: { answerCatalogQuestions?: boolean } = {}
) => {
  const prepare = makeSalePreparer(catalog)
  const answer = makeCatalogAnswerer(catalog)
  return async (messages: string[], previous: SaleDraftV1 | null): Promise<SaleDraftV1 | CatalogAnswer> => {
    const sourceText = messages.join('\n')
    // Real candidates offered before (numbered options): the only IDs a follow-up may pick.
    const previousIds = [...new Set((previous?.items || []).flatMap(i => [...(i.product_id ? [i.product_id] : []), ...i.candidates]))]
    const candidates = (catalog.getProducts
      ? await catalog.getProducts(previousIds)
      : (await Promise.all(previousIds.map(id => catalog.getProduct(id)))).filter((p): p is Product => Boolean(p)))
    // Keep the order in which they were shown.
    candidates.sort((a, b) => previousIds.indexOf(a.id) - previousIds.indexOf(b.id))
    const parsed = await interpret(messages, { previous, candidates })
    if (parsed.intent === 'catalog_query') {
      if (!options.answerCatalogQuestions) return emptyDraft('unsupported', sourceText)
      const reply = await answer(parsed)
      return { kind: 'catalog_answer', ...reply }
    }
    if (parsed.intent !== 'sale') return emptyDraft(parsed.intent, sourceText)
    // Reservations are process 2's job: it recomputes available stock itself.
    const { proposal } = await prepare(parsed, candidates, new Map())
    return toSaleDraft(proposal, sourceText)
  }
}
