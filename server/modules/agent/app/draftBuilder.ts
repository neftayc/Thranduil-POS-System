import { saleDraftSchema, type Product, type SaleDraftV1 } from '../contracts'
import type { SaleProposal } from './agent1Contracts'
import { makeCatalogAnswerer } from './catalogAnswers'
import { makeSalePreparer, type AgentCatalog } from './prepareSale'
import { negatedTerms, spokenHints, type ProductSelector } from './contextSelection'
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
      price_said: line.price_said ?? null,
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
  options: { answerCatalogQuestions?: boolean; selector?: ProductSelector; reservedStock?: () => Promise<Map<string, number>> } = {}
) => {
  const prepare = makeSalePreparer(catalog, { selector: options.selector })
  const answer = makeCatalogAnswerer(catalog, { reservedStock: options.reservedStock })
  return async (messages: string[], previous: SaleDraftV1 | null): Promise<SaleDraftV1 | CatalogAnswer> => {
    const sourceText = messages.join('\n')
    const previousItems = previous?.items || []
    // Lines where options were listed to the seller; their preselected product is only a proposal.
    const choosing = (line: SaleDraftV1['items'][number]) => line.doubts.some(d => d.code === 'ambiguous_product' || d.code === 'product_not_found')
    // Options in the order they were numbered for the seller.
    const offeredIds = [...new Set(previousItems.filter(choosing).flatMap(i => [...(i.product_id ? [i.product_id] : []), ...i.candidates]))]
    // Every real product of the previous draft: the only IDs a follow-up may refer to.
    const previousIds = [...new Set([...offeredIds, ...previousItems.flatMap(i => [...(i.product_id ? [i.product_id] : []), ...i.candidates])])]
    const products = (catalog.getProducts
      ? await catalog.getProducts(previousIds)
      : (await Promise.all(previousIds.map(id => catalog.getProduct(id)))).filter((p): p is Product => Boolean(p)))
    products.sort((a, b) => previousIds.indexOf(a.id) - previousIds.indexOf(b.id))
    const offered = products.filter(p => offeredIds.includes(p.id))
    // The interpreter never sees a preselection as if it were the seller's choice (finding A2).
    const shown: SaleDraftV1 | null = previous && {
      ...previous,
      items: previous.items.map(line => choosing(line)
        ? { ...line, product_id: null, candidates: [...(line.product_id ? [line.product_id] : []), ...line.candidates] }
        : line)
    }
    const parsed = await interpret(messages, { previous: shown, candidates: offered.length ? offered : products })
    if (parsed.intent === 'catalog_query') {
      if (!options.answerCatalogQuestions) return emptyDraft('unsupported', sourceText)
      const reply = await answer(parsed)
      return { kind: 'catalog_answer', ...reply }
    }
    if (parsed.intent !== 'sale') return emptyDraft(parsed.intent, sourceText)
    // Stock and reservations are process 2's job: it recomputes available stock itself.
    // Options of each line, so a clarification («es el Markin») resolves THAT line (only when lines still align).
    const lineOptions = parsed.items.length === previousItems.length
      ? previousItems.map(line => choosing(line) ? products.filter(p => p.id === line.product_id || line.candidates.includes(p.id)) : [])
      : undefined
    const { proposal } = await prepare(parsed, products, new Map(), { lastMessage: messages[messages.length - 1], offered, checkStock: false, lineOptions, hints: spokenHints(sourceText, parsed), sourceText, exclude: negatedTerms(sourceText) })
    return toSaleDraft(proposal, sourceText)
  }
}
