import type {
  Confidence, DraftItem, Interpretation, Product, ProposalAlternative, ProposalItem, SaleDraft, SaleProposal
} from '../contracts'
import { brandVocabulary, closestCandidates, decideMatch, reasonsFor, tiedWithBest, type MatchDecision, type RetrievedDoc } from './productSearch'

export interface AgentCatalog {
  findProducts(query: string, sku?: string | null): Promise<Product[]>
  getProduct(id: string): Promise<Product | null>
  findCustomers(query: string): Promise<Array<{ id: string; name: string }>>
  paymentMethods(): Promise<Array<{ code: string; label: string }>>
  quote(product: Product, qty: number, unit: string | null, customerId: string | null): Promise<{
    unit_name: string; price: number; factor: number; currency: string
  }>
  /** Hybrid retrieval (vectors + text). Without it, findProducts() results are ranked in memory. */
  searchProducts?(query: string): Promise<{ docs: RetrievedDoc[]; brands: Set<string> }>
  /** Live rows (stock) for several products at once. */
  getProducts?(ids: string[]): Promise<Product[]>
}
const normalize = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase()
const round = (value: number, places: number) => Number(value.toFixed(places))
const RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 }
const lowest = (...values: Confidence[]) => values.reduce((a, b) => RANK[a] <= RANK[b] ? a : b, 'high' as Confidence)

/** Text sent to the matcher: the interpreter keeps brand and attributes in `query`; add them if it split them out. */
export const matchQuery = (item: Interpretation['items'][number]) => {
  const query = item.query.trim()
  const extra = [item.brand, ...(item.attributes || [])]
    .filter((value): value is string => Boolean(value?.trim()))
    .filter(value => !normalize(query).includes(normalize(value)))
  return [query, ...extra].join(' ').slice(0, 300)
}

export type ProductMatch = { decision: MatchDecision; products: Map<string, Product> }

/** Retrieves candidates, decides with exact attributes, and loads the live rows of the candidates. */
export const makeProductMatcher = (catalog: AgentCatalog) => async (query: string): Promise<ProductMatch> => {
  let decision: MatchDecision
  let found: Product[] = []
  if (catalog.searchProducts) {
    const { docs, brands } = await catalog.searchProducts(query)
    decision = decideMatch(query, docs, brands)
  } else {
    found = await catalog.findProducts(query, null)
    const docs = found.map(p => ({ id: p.id, name: p.name, brand: p.brand, sku: p.sku, category: null }))
    decision = decideMatch(query, docs, brandVocabulary(docs))
  }
  const ids = [...new Set([...decision.ranked.slice(0, 6), ...closestCandidates(decision.ranked).slice(0, 6)].map(c => c.doc.id))]
  const live = found.length ? found.filter(p => ids.includes(p.id))
    : catalog.getProducts ? await catalog.getProducts(ids)
      : (await Promise.all(ids.map(id => catalog.getProduct(id)))).filter((p): p is Product => Boolean(p))
  return { decision, products: new Map(live.map(p => [p.id, p])) }
}

const describe = (p: Product) => `${p.name}${p.brand ? ` / ${p.brand}` : ''}${p.sku ? ` [${p.sku}]` : ''}`

/**
 * Agent 1: turns the interpreted order into a proposal with real product IDs, live price
 * (resolve_sale_item_pricing) and stock, a confidence level and the reasons for any doubt.
 * `draft` is returned only when everything is `high`; `items` are the fully resolved lines.
 * `reserved` = base units held by other "ventas por confirmar"; they are not available.
 */
export const makeSalePreparer = (catalog: AgentCatalog) => {
  const match = makeProductMatcher(catalog)
  return async (input: Interpretation, previousCandidates: Product[], reserved: Map<string, number> = new Map()) => {
    const candidates: Product[] = []
    const questions: string[] = input.question?.trim() ? [input.question.trim().slice(0, 500)] : []
    const doubts: string[] = [...questions]
    const draft: SaleDraft = { customer_id: null, payment_method: '', items: [], total: 0, currency: 'PEN' }
    const proposal: SaleProposal = { confidence: 'high', customer_id: null, payment_method: null, items: [], total: null, currency: 'PEN', doubts }
    let headConfidence: Confidence = input.question?.trim() ? 'medium' : 'high'
    const ask = (text: string, level: Confidence = 'medium') => {
      questions.push(text)
      doubts.push(text)
      headConfidence = lowest(headConfidence, level)
    }
    if (!input.items.length || input.items.length > 20) {
      const question = 'Indica entre 1 y 20 artículos, con su cantidad, presentación y forma de pago.'
      return { candidates, items: [], question, proposal: { ...proposal, confidence: 'low' as Confidence, doubts: [question] } }
    }
    if (input.customer_query) {
      const customers = await catalog.findCustomers(input.customer_query)
      if (customers.length !== 1) ask(customers.length ? `Especifica el cliente: ${customers.map(c => c.name).join('; ')}.` : 'No encontré ese cliente. Indica su nombre completo o pide una venta al público.')
      else draft.customer_id = proposal.customer_id = customers[0].id
    }
    const methods = await catalog.paymentMethods()
    const payment = methods.find(p => input.payment_method && [p.code, p.label].some(value => normalize(value) === normalize(input.payment_method!)))
    if (!payment) ask(`Indica una forma de pago disponible: ${methods.map(p => p.label).join(', ')}.`)
    else draft.payment_method = proposal.payment_method = payment.code

    for (const [index, item] of input.items.entries()) {
      const label = `Artículo ${index + 1}`
      const line: ProposalItem = {
        line: index + 1, query: item.query, product_id: null, name: null, sku: null, brand: null,
        qty: item.quantity, unit_name: null, factor: null, price_unit: null, total: null, stock_available: null,
        confidence: 'low', match_score: 0, reasons: [], alternatives: []
      }
      proposal.items.push(line)
      const lineDoubt = (text: string, level: Confidence = 'medium') => {
        ask(`${label}: ${text}`, level)
        line.confidence = lowest(line.confidence, level)
      }
      let product: Product | null = null
      if (item.product_id) {
        // An LLM-provided ID is valid only when it came from a previous real candidate.
        if (previousCandidates.some(p => p.id === item.product_id)) product = await catalog.getProduct(item.product_id)
        if (product) Object.assign(line, { confidence: 'high', match_score: 1, reasons: ['elegido por el vendedor entre las opciones'] })
        else lineDoubt('la selección no corresponde a una opción disponible. Indica nuevamente el producto.', 'low')
      } else if (item.sku?.trim()) {
        const matches = await catalog.findProducts(item.query, item.sku)
        if (matches.length === 1) { product = matches[0]; Object.assign(line, { confidence: 'high', match_score: 1, reasons: ['SKU exacto'] }) }
        else if (!matches.length) lineDoubt(`no existe el SKU «${item.sku}». Especifica producto, marca o SKU.`, 'low')
        else {
          const start = candidates.length
          candidates.push(...matches)
          lineDoubt(`el SKU «${item.sku}» corresponde a varios productos: ${matches.map((p, i) => `${start + i + 1}) ${describe(p)}`).join('; ')}.`)
        }
      } else {
        const { decision, products } = await match(matchQuery(item))
        // On a tie, preselect the tied product with the most available stock (never a random one).
        const tied = tiedWithBest(decision).map(c => products.get(c.doc.id)).filter((p): p is Product => Boolean(p))
        const preferred = tied.length > 1 ? [...tied].sort((a, b) => (b.stock - (reserved.get(b.id) || 0)) - (a.stock - (reserved.get(a.id) || 0)))[0] : null
        const best = preferred || (decision.best && products.get(decision.best.doc.id)) || null
        const bestCandidate = best ? decision.ranked.find(c => c.doc.id === best.id) || null : null
        line.alternatives = closestCandidates(decision.ranked)
          .filter(c => c.doc.id !== best?.id && products.has(c.doc.id))
          .slice(0, 5)
          .map((c): ProposalAlternative => ({ product_id: c.doc.id, name: c.doc.name, sku: c.doc.sku, brand: c.doc.brand, score: c.score }))
        if (best && bestCandidate) {
          product = best
          line.confidence = decision.confidence
          line.match_score = bestCandidate.score
          line.reasons = reasonsFor(bestCandidate)
        }
        if (decision.confidence !== 'high') {
          // Offer only real candidates: the best one first, then the closest alternatives.
          const options = [best, ...line.alternatives.map(a => products.get(a.product_id))]
            .filter((p): p is Product => Boolean(p)).slice(0, 6)
          candidates.push(...options.filter(p => !candidates.some(c => c.id === p.id)))
          const list = options.map(p => `${candidates.findIndex(c => c.id === p.id) + 1}) ${describe(p)}`).join('; ')
          const reason = decision.doubts.join(' ') || 'la coincidencia no es exacta.'
          if (best) lineDoubt(`${reason} Propuesta: ${describe(best)}.${options.length > 1 ? ` Opciones: ${list}.` : ''}`, decision.confidence)
          else lineDoubt(`no encontré «${item.query}» con esas características. ${reason}${options.length ? ` Parecidos: ${list}.` : ''} Especifica producto, marca o SKU.`, 'low')
        }
      }
      if (product) {
        Object.assign(line, { product_id: product.id, name: product.name, sku: product.sku, brand: product.brand })
        line.stock_available = round(product.stock - (reserved.get(product.id) || 0), 4)
        if (!candidates.some(p => p.id === product!.id)) candidates.push(product)
      }
      if (item.quantity === null || !Number.isFinite(item.quantity) || item.quantity <= 0 || item.quantity > 1000000) {
        line.qty = null
        lineDoubt('¿cuántas unidades o presentaciones deseas vender? Separa la cantidad del número de hojas u otros atributos.', product ? 'medium' : 'low')
        continue
      }
      if (!product) continue
      try {
        const quote = await catalog.quote(product, item.quantity, item.unit, draft.customer_id)
        if (!Number.isFinite(quote.price) || quote.price < 0 || !Number.isFinite(quote.factor) || quote.factor <= 0 || quote.currency !== 'PEN') throw new Error('Cotización inválida')
        Object.assign(line, { unit_name: quote.unit_name, factor: quote.factor, price_unit: quote.price, total: round(item.quantity * quote.price, 4) })
        // A zero price is almost always a catalog gap: never register it without review.
        if (quote.price === 0) lineDoubt(`${product.name} tiene precio S/ 0.00 en el catálogo. Confirma el precio.`)
        if (line.confidence === 'high') {
          draft.items.push({ product_id: product.id, name: product.name, qty: item.quantity, unit_name: quote.unit_name, price_unit: quote.price, factor: quote.factor, total: line.total! })
        }
      } catch {
        lineDoubt(`no pude cotizar la presentación solicitada para ${product.name}. Indica una presentación válida.`)
      }
    }

    // Stock per product across lines (base units), against what other ventas por confirmar hold.
    const needed = new Map<string, number>()
    for (const line of proposal.items) {
      if (line.product_id && line.qty && line.factor) needed.set(line.product_id, (needed.get(line.product_id) || 0) + line.qty * line.factor)
    }
    for (const [id, qty] of needed) {
      const product = candidates.find(p => p.id === id)!
      const held = reserved.get(id) || 0
      const available = round(product.stock - held, 4)
      if (!Number.isFinite(product.stock) || qty > available + 0.000001) {
        ask(`Stock insuficiente de ${product.name}: hay ${available} ${product.unit} disponibles${held ? ` (${round(held, 4)} reservadas en ventas por confirmar)` : ''}, y el pedido necesita ${round(qty, 4)}.`)
        for (const line of proposal.items) if (line.product_id === id) line.confidence = lowest(line.confidence, 'medium')
      }
    }
    // Lines with a single exact product and a price (stock may still be short): what process 2 can reserve.
    const items: DraftItem[] = draft.items
    proposal.confidence = lowest(headConfidence, ...proposal.items.map(line => line.confidence))
    proposal.total = proposal.items.every(line => line.total !== null) ? round(proposal.items.reduce((sum, line) => sum + line.total!, 0), 2) : null
    if (questions.length || proposal.confidence !== 'high') {
      return { candidates, items, question: questions.join('\n') || 'Revisa el pedido.', proposal }
    }
    draft.total = round(draft.items.reduce((sum, item) => sum + item.total, 0), 2)
    return { candidates, items: draft.items, draft, proposal }
  }
}
