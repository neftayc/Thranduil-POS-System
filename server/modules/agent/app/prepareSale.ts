import type { DraftDoubt, DraftItem, Product, SaleDraft } from '../contracts'
import type {
  Confidence, OrderInterpretation as Interpretation, ProposalAlternative, ProposalItem, SaleProposal
} from './agent1Contracts'
import { explicitChoiceDetail, type ChoiceDetail } from './sellerChoice'
import { resolveQuantity } from './grounding'
import { clarifiedChoice, withContextSelection, type ProductSelector } from './contextSelection'
import { descriptionWithoutQuantity } from './grounding'
import { applyConventions, brandVocabulary, closestCandidates, decideMatch, isUnequivocal, reasonsFor, tiedWithBest, type MatchDecision, type RetrievedDoc } from './productSearch'

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
  // The interpreter sometimes leaves the quantity at the start ("dos cuadernos markin…"): it is not
  // a product word, and keeping it lowers the match. Same rule as process 2 (grounding.ts).
  const query = descriptionWithoutQuantity(item.query.trim()).trim()
  const extra = [item.brand, ...(item.attributes || [])]
    .filter((value): value is string => Boolean(value?.trim()))
    .filter(value => !normalize(query).includes(normalize(value)))
  return [query, ...extra].join(' ').slice(0, 300)
}

export type ProductMatch = { decision: MatchDecision; products: Map<string, Product> }

/**
 * Retrieves candidates, decides with exact attributes and the line's context (type, features,
 * brand), lets the optional selector order equally good options, and loads their live rows.
 */
export const makeProductMatcher = (catalog: AgentCatalog, selector?: ProductSelector) => async (rawQuery: string, useSelector = true, exclude: string[] = []): Promise<ProductMatch> => {
  const query = applyConventions(rawQuery)
  let decision: MatchDecision
  let found: Product[] = []
  if (catalog.searchProducts) {
    const { docs, brands } = await catalog.searchProducts(query)
    decision = decideMatch(query, docs, brands, { exclude })
  } else {
    found = await catalog.findProducts(query, null)
    const docs = found.map(p => ({ id: p.id, name: p.name, brand: p.brand, sku: p.sku, category: null }))
    decision = decideMatch(query, docs, brandVocabulary(docs), { exclude })
  }
  if (useSelector) decision = await withContextSelection(query, decision, selector)
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
export const makeSalePreparer = (catalog: AgentCatalog, options: { selector?: ProductSelector } = {}) => {
  const match = makeProductMatcher(catalog, options.selector)
  /**
   * `context.lastMessage` + `context.offered` (options shown before, in their numbered order):
   * an AI-provided product_id is accepted only if the seller's last message chose it explicitly.
   * `context.lineOptions[i]` = options shown for line i: a clarification («es el Markin») resolves it.
   */
  return async (input: Interpretation, previousCandidates: Product[], reserved: Map<string, number> = new Map(),
    context: { lastMessage?: string; offered?: Product[]; checkStock?: boolean; lineOptions?: Product[][]; hints?: string[]; sourceText?: string; exclude?: string[] } = {}) => {
    const exclude = context.exclude || []
    const search = (query: string, useSelector = true) => match(query, useSelector, exclude)
    /**
     * A choice by option number or SKU is unequivocal. A choice by a WORD only distinguishes it among
     * the options shown, so it is sure only if the whole catalog agrees: the line plus those words
     * must resolve to that same product with no doubt (otherwise the line keeps its options).
     */
    const confirmedChoice = async (detail: ChoiceDetail | null, query: string) => {
      if (!detail) return false
      if (detail.by !== 'word') return true
      const { decision } = await search(`${query} ${detail.words.join(' ')}`, false)
      return decision.confidence === 'high' && decision.best?.doc.id === detail.id
    }
    const candidates: Product[] = []
    // Options listed to the seller in THIS answer, numbered in this order.
    const offered: Product[] = []
    const offer = (products: Product[]) => {
      for (const p of products) if (!offered.some(o => o.id === p.id)) offered.push(p)
      for (const p of products) if (!candidates.some(c => c.id === p.id)) candidates.push(p)
      return products.map(p => `${offered.findIndex(o => o.id === p.id) + 1}) ${describe(p)}`).join('; ')
    }
    const questions: string[] = input.question?.trim() ? [input.question.trim().slice(0, 500)] : []
    const doubts: string[] = [...questions]
    const draft: SaleDraft = { customer_id: null, payment_method: '', items: [], total: 0, currency: 'PEN' }
    const orderDoubts: DraftDoubt[] = input.question?.trim() ? [{ code: 'other', note: input.question.trim().slice(0, 300) }] : []
    const proposal: SaleProposal = { confidence: 'high', customer_id: null, payment_method: null, items: [], total: null, currency: 'PEN', doubts, order_doubts: orderDoubts }
    let headConfidence: Confidence = input.question?.trim() ? 'medium' : 'high'
    const note = (text: string) => text.length > 300 ? `${text.slice(0, 297)}...` : text
    const ask = (text: string, level: Confidence = 'medium', code: DraftDoubt['code'] | null = 'other') => {
      questions.push(text)
      doubts.push(text)
      if (code) orderDoubts.push({ code, note: note(text) })
      headConfidence = lowest(headConfidence, level)
    }
    if (!input.items.length || input.items.length > 20) {
      const question = 'Indica entre 1 y 20 artículos, con su cantidad, presentación y forma de pago.'
      return { candidates, items: [], question, proposal: { ...proposal, confidence: 'low' as Confidence, doubts: [question], order_doubts: [{ code: 'other' as const, note: question }] } }
    }
    if (input.customer_query) {
      const customers = await catalog.findCustomers(input.customer_query)
      if (customers.length !== 1) ask(customers.length ? `Especifica el cliente: ${customers.map(c => c.name).join('; ')}.` : 'No encontré ese cliente. Indica su nombre completo o pide una venta al público.', 'medium', 'customer_ambiguous')
      else draft.customer_id = proposal.customer_id = customers[0].id
    }
    const methods = await catalog.paymentMethods()
    // Business rule: when the seller does not say how the customer pays, it is cash (efectivo).
    // A payment that WAS said but does not exist (or is ambiguous) is still a doubt.
    const said = input.payment_method?.trim() || null
    const payment = said
      ? methods.find(p => [p.code, p.label].some(value => normalize(value) === normalize(said)))
      : methods.find(p => [p.code, p.label].some(value => normalize(value) === 'efectivo'))
    if (!payment) ask(`Indica una forma de pago disponible: ${methods.map(p => p.label).join(', ')}.`, 'medium', 'missing_payment')
    else draft.payment_method = proposal.payment_method = payment.code

    // The quantity process 2 will decide (same rule: resolveQuantity), used to quote.
    const quantityFor = (index: number, item: Interpretation['items'][number]) => {
      const others = input.items.filter((_, i) => i !== index).map(other => other.quantity).filter((q): q is number => q !== null)
      const decided = context.sourceText === undefined ? null
        : resolveQuantity(context.sourceText, item.quantity, item.query, others, { singleLine: input.items.length === 1, unit: item.unit })
      return decided?.ok ? decided.quantity : item.quantity ?? 1
    }
    for (const [index, item] of input.items.entries()) {
      const label = `Artículo ${index + 1}`
      const line: ProposalItem = {
        line: index + 1, query: item.query, product_id: null, name: null, sku: null, brand: null,
        qty: item.quantity, unit: item.unit?.trim() || null, unit_name: null, factor: null, price_unit: null,
        price_said: typeof item.price === 'number' && item.price > 0 ? item.price : null, total: null, stock_available: null,
        confidence: 'low', match_score: 0, reasons: [], doubts: [], alternatives: []
      }
      proposal.items.push(line)
      const lineDoubt = (text: string, level: Confidence = 'medium', code: DraftDoubt['code'] = 'other') => {
        ask(`${label}: ${text}`, level, null)
        line.doubts.push({ code, note: note(text) })
        line.confidence = lowest(line.confidence, level)
      }
      let product: Product | null = null
      // An AI-provided ID counts only if it was a real candidate offered before AND the seller's
      // last message picked it deterministically (option number, SKU or a distinctive word).
      // Otherwise the line is searched again (a preselection never becomes a sale by itself).
      const known = item.product_id ? previousCandidates.find(p => p.id === item.product_id) : undefined
      const pick = known ? explicitChoiceDetail(context.lastMessage, context.offered?.length ? context.offered : previousCandidates) : null
      const chosen = Boolean(known && pick?.id === known.id && await confirmedChoice(pick, matchQuery(item)))
      // The seller's clarification of THIS line, pointing to one of its real options (A2 still holds).
      const clarification = !item.product_id && !item.sku?.trim()
        ? clarifiedChoice(context.lastMessage, context.offered || [], context.lineOptions?.[index], matchQuery(item), exclude)
        : null
      const clarified = clarification && await confirmedChoice(clarification, matchQuery(item)) ? clarification.product : null
      if (item.product_id && !known) {
        lineDoubt('la selección no corresponde a una opción disponible. Indica nuevamente el producto.', 'low', 'product_not_found')
      } else if (chosen) {
        product = await catalog.getProduct(item.product_id!)
        if (product) Object.assign(line, { confidence: 'high', match_score: 1, reasons: ['elegido por el vendedor entre las opciones'] })
        else lineDoubt('la opción elegida ya no está disponible. Indica nuevamente el producto.', 'low', 'product_not_found')
      } else if (clarified) {
        product = await catalog.getProduct(clarified.id)
        if (product) Object.assign(line, { confidence: 'high', match_score: 1, reasons: ['aclarado por el vendedor entre las opciones de esta línea'] })
        else lineDoubt('la opción elegida ya no está disponible. Indica nuevamente el producto.', 'low', 'product_not_found')
      } else if (item.sku?.trim()) {
        const matches = await catalog.findProducts(item.query, item.sku)
        if (matches.length === 1) { product = matches[0]; Object.assign(line, { confidence: 'high', match_score: 1, reasons: ['SKU exacto'] }) }
        else if (!matches.length) lineDoubt(`no existe el SKU «${item.sku}». Especifica producto, marca o SKU.`, 'low', 'product_not_found')
        else {
          line.alternatives = matches.slice(0, 5).map(p => ({ product_id: p.id, name: p.name, sku: p.sku, brand: p.brand, score: 1 }))
          lineDoubt(`el SKU «${item.sku}» corresponde a varios productos: ${offer(matches.slice(0, 5))}.`, 'medium', 'ambiguous_product')
        }
      } else {
        // Words the seller said that the interpreter dropped (single-line orders only): a hint is kept
        // only if it makes the line unequivocal, so it can never make the choice worse.
        const hints = input.items.length === 1 ? (context.hints || []) : []
        let { decision, products } = await search(matchQuery(item), !hints.length)
        let hintUsed: string | null = null
        if (decision.confidence !== 'high' && hints.length) {
          for (const hint of hints) {
            const retry = await search(`${matchQuery(item)} ${hint}`, false)
            if (retry.decision.confidence === 'high') { ({ decision, products } = retry); hintUsed = hint; break }
          }
          if (!hintUsed) decision = await withContextSelection(matchQuery(item), decision, options.selector)
        }
        // The price the seller dictated breaks a tie when exactly ONE equally compatible product has
        // that list price («lapicero Faber-Castell azul de un sol»). Never across types or features.
        let priceUsed: number | null = null
        const said = typeof item.price === 'number' && item.price > 0 ? item.price : null
        if (said !== null && decision.confidence !== 'high' && decision.best) {
          const tiedCandidates = tiedWithBest(decision).filter(c => products.has(c.doc.id)).slice(0, 8)
          if (tiedCandidates.length > 1) {
            const priced = await Promise.all(tiedCandidates.map(async c => {
              try { return { c, price: (await catalog.quote(products.get(c.doc.id)!, quantityFor(index, item), item.unit, draft.customer_id)).price } } catch { return { c, price: null } }
            }))
            const same = priced.filter(r => r.price !== null && Math.abs(r.price - said) < 0.005)
            if (same.length === 1) {
              const winner = same[0].c
              priceUsed = said
              decision = {
                ...decision, best: winner, selected: winner.doc.id,
                ranked: [winner, ...decision.ranked.filter(c => c !== winner)],
                confidence: isUnequivocal(winner) ? 'high' : decision.confidence,
                doubts: isUnequivocal(winner) ? [] : decision.doubts
              }
            }
          }
        }
        // On a tie, preselect the tied product with the most available stock (never a random one).
        const tied = tiedWithBest(decision).map(c => products.get(c.doc.id)).filter((p): p is Product => Boolean(p))
        const preferred = tied.length > 1 && !decision.selected ? [...tied].sort((a, b) => (b.stock - (reserved.get(b.id) || 0)) - (a.stock - (reserved.get(a.id) || 0)))[0] : null
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
          line.reasons = [...(hintUsed ? [`«${hintUsed}» lo dijo el vendedor`] : []), ...(priceUsed !== null ? [`único con el precio dictado S/ ${priceUsed.toFixed(2)}`] : []), ...reasonsFor(bestCandidate)]
        }
        if (decision.confidence !== 'high') {
          // Offer only real candidates: the best one first, then the closest alternatives.
          const options = [best, ...line.alternatives.map(a => products.get(a.product_id))]
            .filter((p): p is Product => Boolean(p)).slice(0, 6)
          const list = offer(options)
          const reason = decision.doubts.join(' ') || 'la coincidencia no es exacta.'
          if (best) lineDoubt(`${reason} Propuesta: ${describe(best)}.${options.length > 1 ? ` Opciones: ${list}.` : ''}`, decision.confidence, 'ambiguous_product')
          else lineDoubt(`no encontré «${item.query}» con esas características. ${reason}${options.length ? ` Parecidos: ${list}.` : ''} Especifica producto, marca o SKU.`, 'low', 'product_not_found')
        }
      }
      if (product) {
        Object.assign(line, { product_id: product.id, name: product.name, sku: product.sku, brand: product.brand })
        line.stock_available = round(product.stock - (reserved.get(product.id) || 0), 4)
        if (!candidates.some(p => p.id === product!.id)) candidates.push(product)
      }
      // No quantity said → 1 (business rule). The line keeps qty null so process 2 records the default.
      if (item.quantity !== null && (!Number.isFinite(item.quantity) || item.quantity <= 0 || item.quantity > 1000000)) {
        line.qty = null
        lineDoubt('la cantidad indicada no es válida. Separa la cantidad del número de hojas u otros atributos.', product ? 'medium' : 'low', 'missing_quantity')
        continue
      }
      // Quote with the quantity process 2 will decide (same rule: resolveQuantity), so a dropped
      // quantity («doce lapiceros…») is priced at the wholesale tier too, not at 1.
      const quantity = quantityFor(index, item)
      if (!product) continue
      try {
        const quote = await catalog.quote(product, quantity, item.unit, draft.customer_id)
        if (!Number.isFinite(quote.price) || quote.price < 0 || !Number.isFinite(quote.factor) || quote.factor <= 0 || quote.currency !== 'PEN') throw new Error('Cotización inválida')
        Object.assign(line, { unit_name: quote.unit_name, factor: quote.factor, price_unit: quote.price, total: round(quantity * quote.price, 4) })
        // A zero price is almost always a catalog gap: never register it without review.
        if (quote.price === 0) lineDoubt(`${product.name} tiene precio S/ 0.00 en el catálogo. Confirma el precio.`)
        if (line.confidence === 'high') {
          draft.items.push({ product_id: product.id, name: product.name, qty: quantity, unit_name: quote.unit_name, price_unit: quote.price, factor: quote.factor, total: line.total! })
        }
      } catch {
        lineDoubt(`no pude cotizar la presentación solicitada para ${product.name}. Indica una presentación válida.`, 'medium', 'unit_unclear')
      }
    }

    // Stock per product across lines (base units), against what other ventas por confirmar hold.
    const needed = new Map<string, number>()
    for (const line of proposal.items) {
      if (line.product_id && line.factor) needed.set(line.product_id, (needed.get(line.product_id) || 0) + (line.qty ?? 1) * line.factor)
    }
    // In buildDraft the stock is decided by process 2 (insufficient_stock): not repeated here as a doubt.
    for (const [id, qty] of context.checkStock === false ? [] : needed) {
      const product = candidates.find(p => p.id === id)!
      const held = reserved.get(id) || 0
      const available = round(product.stock - held, 4)
      if (!Number.isFinite(product.stock) || qty > available + 0.000001) {
        const text = `Stock insuficiente de ${product.name}: hay ${available} ${product.unit} disponibles${held ? ` (${round(held, 4)} reservadas en ventas por confirmar)` : ''}, y el pedido necesita ${round(qty, 4)}.`
        ask(text, 'medium', null)
        for (const line of proposal.items) {
          if (line.product_id !== id) continue
          line.confidence = lowest(line.confidence, 'medium')
          line.doubts.push({ code: 'other', note: note(text) })
        }
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
