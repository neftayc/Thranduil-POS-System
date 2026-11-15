import type { Product } from '../contracts'
import { explicitChoice } from './sellerChoice'
import type { OrderInterpretation } from './agent1Contracts'
import { applyConventions } from './catalogConventions'
import { brandVocabulary, contentWords, decideMatch, similarWord, tiedWithBest, type Confidence, type MatchDecision, type RankedCandidate } from './productSearch'

/**
 * Product selection by CONTEXT (after the hybrid search and the exact-signal decision).
 *
 * The line is read in parts: type (cuaderno), features (cuadriculado, 100 hojas, A4…) and
 * brand/model (marking → Markin, tolerant to dictation). Type and features are filtered
 * deterministically in productSearch.ts (conventions in catalogConventions.ts). What is left
 * here:
 *  1. an LLM selector that orders and justifies among candidates that are EQUALLY compatible
 *     (it can only pick one of them, never invent one, and never turns a real tie into «high»);
 *  2. the seller's clarification in a follow-up («es el Markin») for the line that had options.
 */

export type SelectorCandidate = {
  n: number
  product_id: string
  name: string
  brand: string | null
  category: string | null
  matched: string[]
  unknown: string[]
}
export type ProductSelection = { product_id: string | null; confidence: Confidence; reason: string }
export type ProductSelector = (line: { query: string }, candidates: SelectorCandidate[]) => Promise<ProductSelection>

const MAX_SELECTOR_CANDIDATES = 8

/**
 * Asks the selector to choose among the candidates tied with the best one.
 * Never upgrades the confidence: a tie stays «medium» (doubt with the options); the pick
 * becomes the preselected option and its reason is shown to the seller.
 */
export const withContextSelection = async (query: string, decision: MatchDecision, selector?: ProductSelector): Promise<MatchDecision> => {
  if (!selector || decision.confidence === 'high') return decision
  const pool = tiedWithBest(decision).slice(0, MAX_SELECTOR_CANDIDATES)
  if (pool.length < 2) return decision
  let pick: ProductSelection
  try {
    pick = await selector({ query: query.slice(0, 300) }, pool.map((c, i): SelectorCandidate => ({
      n: i + 1, product_id: c.doc.id, name: c.doc.name, brand: c.doc.brand, category: c.doc.category, matched: c.matched, unknown: c.unknown
    })))
  } catch {
    return decision // the deterministic preselection stays
  }
  const chosen: RankedCandidate | undefined = pick.product_id ? pool.find(c => c.doc.id === pick.product_id) : undefined
  if (!chosen) return decision
  const reason = pick.reason.replace(/\s+/g, ' ').trim().slice(0, 200)
  return {
    ...decision,
    best: chosen,
    ranked: [chosen, ...decision.ranked.filter(c => c !== chosen)],
    doubts: [...decision.doubts, `Sugerencia por contexto: ${chosen.doc.name}${reason ? ` (${reason})` : ''}.`],
    selected: chosen.doc.id
  }
}

/**
 * The seller's clarification for a line that had options («es el Markin», «la 2», a SKU):
 * returns the option it points to, only if it is a real option of THAT line and it does not
 * contradict the line as now described (e.g. «el surco rayado» does not pick «surco #»).
 */
export const clarifiedChoice = (lastMessage: string | undefined, offered: Product[], lineOptions: Product[] | undefined, lineQuery: string): Product | null => {
  if (!lineOptions?.length) return null
  // Numbers/SKU/words are read against ALL the options in the order they were numbered for the seller.
  const id = explicitChoice(lastMessage, offered.length ? offered : lineOptions)
  const product = id ? lineOptions.find(p => p.id === id) : undefined
  if (!product) return null
  const docs = lineOptions.map(p => ({ id: p.id, name: p.name, brand: p.brand, sku: p.sku, category: null }))
  const check = decideMatch(lineQuery, docs.filter(d => d.id === product.id), brandVocabulary(docs)).ranked[0]
  return check && !check.conflicts.length ? product : null
}

// Words of an order that are never a brand or model: quantities, payment, verbs and fillers.
const NOT_HINTS = new Set([
  'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce', 'docena', 'docenas', 'media', 'medio', 'par',
  'efectivo', 'yape', 'plin', 'tarjeta', 'transferencia', 'pago', 'paga', 'pagar', 'cobra', 'cobrar', 'cobro', 'contado', 'credito', 'deposito',
  'vender', 'vende', 'vendo', 'venta', 'quiero', 'dame', 'deme', 'ponme', 'agrega', 'agregar', 'llevo', 'lleva', 'favor', 'porfa', 'gracias',
  'cliente', 'publico', 'otro', 'otra', 'mas', 'tambien', 'solo', 'nada', 'eso', 'esto', 'ese', 'esa', 'cada'
])

/**
 * Words the seller SAID that did not reach the interpreted line (e.g. «marca marking» lost by the
 * interpreter): «marca/línea/modelo X» first, then any other leftover word. They are only HINTS:
 * prepareSale tries them one by one and keeps a hint only if it makes the line unequivocal.
 */
export const spokenHints = (sellerText: string, input: OrderInterpretation, limit = 3): string[] => {
  const used = contentWords(input.items.flatMap(i => [i.query, i.product || '', i.brand || '', ...(i.attributes || []), i.unit || ''])
    .concat(input.payment_method || '', input.customer_query || '').join(' '))
  const text = applyConventions(sellerText)
  const marked = [...text.matchAll(/\b(?:marca|linea|modelo)\s+([a-z]{3,})/g)].map(m => m[1])
  const hints: string[] = []
  for (const word of [...marked, ...contentWords(text)]) {
    if (NOT_HINTS.has(word) || hints.includes(word) || used.some(u => similarWord(u, word))) continue
    hints.push(word)
  }
  return hints.slice(0, limit)
}
