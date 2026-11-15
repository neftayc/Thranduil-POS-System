import type { Product } from '../contracts'
import { explicitChoiceDetail, type ChoiceDetail } from './sellerChoice'
import type { OrderInterpretation } from './agent1Contracts'
import { applyConventions } from './catalogConventions'
import { brandVocabulary, contentWords, decideMatch, normalizeText, similarWord, tiedWithBest, type Confidence, type MatchDecision, type RankedCandidate } from './productSearch'

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
export const clarifiedChoice = (lastMessage: string | undefined, offered: Product[], lineOptions: Product[] | undefined, lineQuery: string, exclude: string[] = []): (ChoiceDetail & { product: Product }) | null => {
  if (!lineOptions?.length) return null
  // Numbers/SKU/words are read against ALL the options in the order they were numbered for the seller.
  const detail = explicitChoiceDetail(lastMessage, offered.length ? offered : lineOptions)
  const product = detail ? lineOptions.find(p => p.id === detail.id) : undefined
  if (!detail || !product) return null
  const docs = lineOptions.map(p => ({ id: p.id, name: p.name, brand: p.brand, sku: p.sku, category: null }))
  const check = decideMatch(lineQuery, docs.filter(d => d.id === product.id), brandVocabulary(docs), { exclude }).ranked[0]
  // A word choice is still only a candidate: prepareSale confirms it against the whole catalog.
  return check && !check.conflicts.length ? { ...detail, product } : null
}

// Words after a negation that are not attributes («no, mejor el surco»).
const NOT_EXCLUDED = new Set(['mejor', 'se', 'hay', 'tengo', 'tiene', 'tienen', 'queda', 'quedan', 'pago', 'cliente', 'importa', 'problema', 'gracias', 'nada', 'mas', 'eso', 'esto', 'ese', 'esa', 'si', 'solo', 'era', 'es', 'ese'])
const NEGATIONS = [
  /\b(?:no|nunca|sin|ni)\s+(?:(?:es|era|son|sea|sean|dije|dijimos|dijo|pedi|pedimos|quiero|queremos|quiere|lleva|llevan|el|la|los|las|un|una|de|del|con|que|en)\s+){0,3}([a-z0-9]+)/g,
  /\ben ningun momento\s+(?:(?:se|le|lo|la|les)\s+)?(?:dije|dijimos|dijo|pedi|pedimos|mencione|mencionamos|hablamos de|hable de)\s+(?:(?:el|la|los|las|un|una|de|del|que)\s+){0,2}([a-z0-9]+)/g
]

/**
 * Terms the seller EXCLUDED («en ningún momento dijimos A4», «no es A4», «sin espiral», «no el
 * rayado»). Candidates having them are discarded, except in a line that asks for that term itself.
 */
export const negatedTerms = (sellerText: string): string[] => {
  const text = normalizeText(sellerText)
  const terms = new Set<string>()
  for (const pattern of NEGATIONS) for (const m of text.matchAll(pattern)) if (m[1].length >= 2 && !NOT_EXCLUDED.has(m[1])) terms.add(m[1])
  return [...terms].slice(0, 10)
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
