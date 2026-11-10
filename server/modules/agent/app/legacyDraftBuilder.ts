import type { Interpretation, Product, SaleDraftV1 } from '../contracts'

/**
 * PROVISIONAL "agent 1": the previous OpenAI interpreter + text search, adapted to emit
 * sale-draft/1. It keeps the POS working until the hybrid (vector + text) search of agent 1
 * replaces it. It never decides anything: process 2 re-verifies every field.
 */
export interface SearchCatalog {
  findProducts(query: string, sku?: string | null): Promise<Product[]>
  getProduct(id: string): Promise<Product | null>
  findCustomers(query: string): Promise<Array<{ id: string; name: string }>>
}
export type LegacyInterpreter = (messages: string[], context: { previous: SaleDraftV1 | null; candidates: Product[] }) => Promise<Interpretation>

export const makeLegacyDraftBuilder = (interpret: LegacyInterpreter, catalog: SearchCatalog) => async (messages: string[], previous: SaleDraftV1 | null): Promise<SaleDraftV1> => {
  const previousIds = [...new Set((previous?.items || []).flatMap(i => [...(i.product_id ? [i.product_id] : []), ...i.candidates]))]
  const candidates = (await Promise.all(previousIds.map(id => catalog.getProduct(id)))).filter((p): p is Product => Boolean(p))
  const parsed = await interpret(messages, { previous, candidates })
  const draft: SaleDraftV1 = {
    version: 'sale-draft/1', intent: parsed.intent, items: [], payment_method: parsed.payment_method?.trim() || null,
    customer_id: null, doubts: parsed.question?.trim() ? [{ code: 'other', note: parsed.question.trim().slice(0, 300) }] : [],
    source_text: messages.join('\n').slice(0, 5000)
  }
  if (parsed.intent !== 'sale') return draft
  if (parsed.customer_query?.trim()) {
    const customers = await catalog.findCustomers(parsed.customer_query)
    if (customers.length === 1) draft.customer_id = customers[0].id
    else draft.doubts.push({ code: 'customer_ambiguous', note: customers.length ? `Cliente: ${customers.map(c => c.name).join('; ')}`.slice(0, 300) : 'Cliente no encontrado' })
  }
  for (const item of parsed.items.slice(0, 20)) {
    const line: SaleDraftV1['items'][number] = {
      product_id: null, candidates: [], quantity: item.quantity, unit: item.unit?.trim() || null, price_unit: null,
      confidence: 'low', doubts: [], query: item.query.slice(0, 500)
    }
    if (item.product_id && candidates.some(p => p.id === item.product_id)) {
      // Explicit choice among real candidates shown before.
      line.product_id = item.product_id
      line.confidence = 'high'
    } else {
      const matches = await catalog.findProducts(item.query, item.sku)
      if (matches.length === 1) {
        line.product_id = matches[0].id
        line.confidence = 'high'
      } else if (matches.length) {
        line.candidates = matches.slice(0, 8).map(p => p.id)
        line.doubts.push({ code: 'ambiguous_product', note: `Opciones: ${matches.slice(0, 8).map(p => `${p.name}${p.brand ? ` / ${p.brand}` : ''} [${p.sku}]`).join('; ')}`.slice(0, 300) })
      } else {
        line.doubts.push({ code: 'product_not_found' })
      }
    }
    if (item.quantity === null) line.doubts.push({ code: 'missing_quantity' })
    draft.items.push(line)
  }
  return draft
}
