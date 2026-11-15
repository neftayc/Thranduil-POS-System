/**
 * Product matching for the sales agent (pure, no I/O).
 *
 * Retrieval (vectors + trigram/word match, combined with RRF) only proposes candidates.
 * The DECISION is taken here with exact signals: numbers and measures (100 vs 50 hojas,
 * 250 g, 30 cm, x12), ruling (# = cuadriculado, rayado, triple renglón, 1x1/2x2), size
 * (A4/grande vs A5/pequeño) and brand. Similarity alone never makes a sale "high".
 */

import { applyConventions, CUADRIMAX_DIMS, phoneticKey, RULING_WORDS, SIZE_WORDS, SYNONYMS } from './catalogConventions'

export { applyConventions } from './catalogConventions'

export type SearchDoc = {
  id: string
  name: string
  brand: string | null
  category: string | null
  sku: string | null
  synonyms?: string[]
}
export type RetrievedDoc = SearchDoc & { lexical_rank?: number | null; vector_rank?: number | null; vector_similarity?: number | null }
export type Confidence = 'high' | 'medium' | 'low'
export type RankedCandidate = {
  doc: SearchDoc
  coverage: number
  matched: string[]
  unknown: string[]
  conflicts: string[]
  extra: number
  learned: boolean
  retrieval: number
  score: number
}
export type MatchDecision = {
  confidence: Confidence
  best: RankedCandidate | null
  ranked: RankedCandidate[]
  doubts: string[]
  /** Product picked by the context selector among equally compatible ones (preselection only). */
  selected?: string
}

const STOPWORDS = new Set([
  'de', 'del', 'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'con', 'para', 'y', 'e', 'en', 'por', 'al', 'a',
  'vender', 'vende', 'vendo', 'venta', 'quiero', 'dame', 'deme', 'necesito', 'me', 'da', 'tipo', 'marca', 'modelo',
  'pulgada', 'pulgadas', 'medida', 'tamano', 'paquete', 'paquetes', 'und', 'unidad', 'unidades'
])
const SYNONYM_INDEX = (() => {
  const index = new Map<string, Set<string>>()
  for (const [key, values] of Object.entries(SYNONYMS)) {
    const group = [key, ...values]
    for (const word of group) {
      const set = index.get(word) || new Set<string>()
      for (const other of group) if (other !== word) set.add(other.replace(/\s+/g, ''))
      index.set(word, set)
    }
  }
  return index
})()

const UNIT_ALIASES: Array<[RegExp, string]> = [
  [/^(g|gr|grs|gramo|gramos)$/, 'g'],
  [/^(kg|kilo|kilos)$/, 'kg'],
  [/^(ml|mililitro|mililitros)$/, 'ml'],
  [/^(l|lt|litro|litros)$/, 'l'],
  [/^(cm|centimetro|centimetros)$/, 'cm'],
  [/^(mm|milimetro|milimetros)$/, 'mm'],
  [/^(m|mt|metro|metros)$/, 'm'],
  [/^(h|hj|hjs|hoja|hojas|f|fs|folio|folios)$/, 'hojas'],
  [/^(pieza|piezas|piesa|piesas|pzs|pz)$/, 'piezas'],
  [/^(und|unds|u|un|unid|unidad|unidades|colores|pares|leds)$/, 'pack']
]
export const normalizeText = (value: string) => value
  .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/#/g, ' cuadriculado ')
  .replace(/(\d+)\s+(\d+)\/(\d+)/g, (_, a, b, c) => String(Number(a) + Number(b) / Number(c)))
  .replace(/(\d+)\/(\d+)/g, (_, b, c) => String(Number(b) / Number(c)))
  .replace(/(\d+(?:\.\d+)?)\s*[x*]\s*(\d+(?:\.\d+)?)/g, ' $1x$2 ')
  .replace(/\bx\s*(\d+)/g, ' x$1 ')
  .replace(/(\d)([a-z]{1,9})\b/g, (match, digit, letters) => /^x\d/.test(letters) ? match : UNIT_ALIASES.some(([re]) => re.test(letters)) ? `${digit} ${letters}` : match)
  .replace(/\.(?!\d)/g, ' ')
  .replace(/[^a-z0-9.\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()

/** Optimal string alignment distance (Damerau–Levenshtein with adjacent transpositions). */
const editDistance = (a: string, b: string) => {
  if (Math.abs(a.length - b.length) > 2) return 3
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
    }
  }
  return d[a.length][b.length]
}
const singular = (word: string) => word.length > 4 && word.endsWith('es') && !word.endsWith('ces') ? word.slice(0, -2)
  : word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word
export const similarWord = (a: string, b: string) => {
  if (a === b) return true
  const sa = singular(a), sb = singular(b)
  if (sa === sb) return true
  if (/\d/.test(a) || /\d/.test(b)) return false
  const min = Math.min(sa.length, sb.length)
  if (min >= 4 && editDistance(sa, sb) <= 1) return true
  if (min >= 8 && editDistance(sa, sb) <= 2 && sa[0] === sb[0]) return true
  // Dictation errors that sound the same (margen / marking → markin); never masking → markin.
  if (min >= 5 && phoneticKey(sa) === phoneticKey(sb)) return true
  return false
}
const fuzzyCanonical = <T>(word: string, table: Array<[RegExp, ...T[]]>) => {
  for (const row of table) if (row[0].test(word)) return row
  if (word.length >= 5) {
    for (const row of table) {
      const source = row[0].source.replace(/^\^\(?|\)?\$$/g, '').split('|')
      if (source.some(option => /^[a-z]+$/.test(option) && option.length >= 5 && editDistance(word, option) <= 1)) return row
    }
  }
  return null
}

const MISSING_MEASURE = ' no figura en el producto'

export type Attributes = {
  measures: Map<string, number[]>
  numbers: number[]
  dims: string[]
  ruling: string | null
  size: { label: string; group: string } | null
  words: string[]
}

/** Extracts exact attributes and the remaining content words from a (normalized) text. */
export const parseAttributes = (raw: string, stripLeadingQuantity = false): Attributes => {
  const tokens = normalizeText(raw).split(' ').filter(Boolean)
  if (stripLeadingQuantity && tokens.length > 2 && /^\d+$/.test(tokens[0]) && /^[a-z]{3,}$/.test(tokens[1]) && !UNIT_ALIASES.some(([re]) => re.test(tokens[1]))) tokens.shift()
  const attrs: Attributes = { measures: new Map(), numbers: [], dims: [], ruling: null, size: null, words: [] }
  const addMeasure = (unit: string, value: number) => attrs.measures.set(unit, [...(attrs.measures.get(unit) || []), value])
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i], next = tokens[i + 1] || ''
    if (/^\d+(\.\d+)?x\d+(\.\d+)?$/.test(token)) {
      attrs.dims.push(token)
      attrs.numbers.push(...token.split('x').map(Number))
      continue
    }
    if (/^x\d+$/.test(token)) { addMeasure('pack', Number(token.slice(1))); continue }
    if (/^\d+(\.\d+)?$/.test(token)) {
      const unit = UNIT_ALIASES.find(([re]) => re.test(next))?.[1]
      if (unit) { addMeasure(unit, Number(token)); i++; continue }
      attrs.numbers.push(Number(token))
      continue
    }
    if (token === 'triple' && /^(renglon|reglon|raya|rayas|linea|lineas)$/.test(next)) { attrs.ruling = 'triple'; i++; continue }
    if (token === 'triple') { attrs.ruling = 'triple'; continue }
    const ruling = fuzzyCanonical<string>(token, RULING_WORDS)
    if (ruling) { attrs.ruling = ruling[1]; continue }
    const size = fuzzyCanonical<string>(token, SIZE_WORDS)
    if (size) { attrs.size = { label: size[1], group: size[2] }; continue }
    if (STOPWORDS.has(token) || token.length < 2) continue
    attrs.words.push(token)
  }
  return attrs
}

const allNumbers = (attrs: Attributes) => [...attrs.numbers, ...[...attrs.measures.values()].flat()]
const sameNumber = (a: number, b: number) => Math.abs(a - b) < 0.0001

const docText = (doc: SearchDoc) => [doc.name, doc.brand, doc.category].filter(Boolean).join(' ')

const wordPresent = (word: string, candidateWords: string[]) => {
  const options = [word, ...(SYNONYM_INDEX.get(word) || []), ...(SYNONYM_INDEX.get(singular(word)) || [])]
  for (const option of options) {
    for (let i = 0; i < candidateWords.length; i++) {
      const candidate = candidateWords[i]
      if (similarWord(option, candidate)) return true
      // compound words: "sketchbook" = "sketch book", "sacapunta" = "saca punta"
      if (i + 1 < candidateWords.length && similarWord(option, candidate + candidateWords[i + 1])) return true
      // abbreviations/glued words: "cuad" ⊂ "cuaderno", "cuaderno" ⊂ "cuadernouniversal"
      if (option.length >= 4 && candidate.startsWith(option)) return true
      if (option.length >= 6 && candidate.includes(option)) return true
    }
  }
  return false
}

/** Content words of a text (no stopwords, no pure numbers), for the seller-choice check. */
export const contentWords = (text: string) => normalizeText(text).split(' ')
  .filter(word => word.length >= 3 && !STOPWORDS.has(word) && !/^\d+(\.\d+)?$/.test(word))

export const brandVocabulary = (docs: SearchDoc[]) => {
  const brands = new Set<string>()
  for (const doc of docs) {
    for (const word of normalizeText(doc.brand || '').split(' ')) if (word.length >= 3 && !/\d/.test(word)) brands.add(word)
  }
  return brands
}

/** Ruling of a text: explicit word, or from its grid dimensions (1x1/2x2 = cuadrimax, other = cuadriculado). */
const rulingOf = (attrs: Attributes) => {
  const cuadrimax = attrs.dims.some(d => CUADRIMAX_DIMS.has(d))
  if (attrs.ruling) return attrs.ruling === 'cuadriculado' && cuadrimax ? 'cuadrimax' : attrs.ruling
  return cuadrimax ? 'cuadrimax' : attrs.dims.length ? 'cuadriculado' : null
}

/** Type words of a product: its category (cuaderno, cinta, borrador…). */
const typeWordsOf = (doc: SearchDoc) => parseAttributes(doc.category || '').words

/**
 * PRODUCT TYPE of the order line: the first word of the order that is the category of some
 * retrieved product («cuaderno marking 100 hojas» → cuaderno; «cinta marking» → cinta).
 * null when the order names no category (then nothing is filtered by type).
 */
export const lineType = (query: Attributes, docs: SearchDoc[]): string | null => {
  const categories = [...new Set(docs.flatMap(typeWordsOf))]
  return query.words.find(word => wordPresent(word, categories)) ?? null
}
/** A product is of that type if its category or its name (or a learned synonym) says so. */
const isOfType = (type: string, doc: SearchDoc) => wordPresent(type, typeWordsOf(doc)) ||
  wordPresent(type, [...parseAttributes(doc.name).words, ...(doc.synonyms || []).flatMap(text => parseAttributes(text).words)])

/**
 * Scores one candidate against the query. Conflicts are exact contradictions
 * (a different number of sheets, a different brand...). Unknown = the product
 * does not say (e.g. the order says A4 and the name does not mention a size).
 */
export const scoreCandidate = (query: Attributes, doc: SearchDoc, brands: Set<string>, normalizedQuery: string, type: string | null = null): Omit<RankedCandidate, 'retrieval' | 'score'> => {
  const own = parseAttributes(docText(doc))
  const synonymTexts = (doc.synonyms || []).map(normalizeText)
  const synonymWords = synonymTexts.flatMap(text => parseAttributes(text).words)
  const candidateWords = [...own.words, ...synonymWords]
  const nameWords = parseAttributes(doc.name).words
  const brandWords = normalizeText(doc.brand || '').split(' ').filter(Boolean)
  const matched: string[] = [], unknown: string[] = [], conflicts: string[] = []
  const learned = synonymTexts.some(text => text === normalizedQuery)
  // A notebook is never a tape: a product of another type is out, whatever the brand or model says.
  if (type && !learned && !isOfType(type, doc)) conflicts.push(`es ${doc.category ? normalizeText(doc.category) : 'otro tipo de producto'}, no ${type}`)

  // Content words (product type, line, colour, brand).
  let covered = 0
  for (const word of query.words) {
    if (wordPresent(word, candidateWords)) { covered++; continue }
    if (brands.has(word) || [...brands].some(brand => brand.length >= 5 && similarWord(word, brand))) {
      conflicts.push(`la marca pedida «${word}» no coincide${doc.brand ? ` (es ${doc.brand})` : ''}`)
    }
  }
  const coverage = query.words.length ? covered / query.words.length : (allNumbers(query).length || query.ruling ? 0.75 : 0)
  // Product words the order did not mention (brand excluded): "juego de reglas" vs "regla".
  const extra = nameWords.filter(word => !brandWords.includes(word) && !query.words.some(q => wordPresent(q, [word]))).length

  // Measures with units.
  for (const [unit, values] of query.measures) {
    const theirs = own.measures.get(unit)
    const label = unit === 'pack' ? `x${values.join('/')}` : `${values.join('/')} ${unit}`
    if (theirs?.length) {
      if (values.every(v => theirs.some(t => sameNumber(v, t)))) matched.push(label)
      else conflicts.push(`${label} no coincide (el producto dice ${theirs.join('/')} ${unit === 'pack' ? 'unidades' : unit})`)
    } else if (values.every(v => own.numbers.some(t => sameNumber(v, t)))) {
      matched.push(label)
    } else if (allNumbers(own).length && unit === 'hojas') {
      conflicts.push(`${label} no coincide con ${doc.name}`)
    } else unknown.push(`${label} ${MISSING_MEASURE}`)
  }
  // Plain numbers ("cuaderno ... 100 a4"): must appear somewhere in the product.
  const theirNumbers = allNumbers(own)
  for (const value of query.numbers) {
    if (query.dims.some(d => d.split('x').map(Number).includes(value))) continue
    if (theirNumbers.some(n => sameNumber(n, value))) matched.push(String(value))
    else if (theirNumbers.length) conflicts.push(`${value} no coincide (el producto dice ${theirNumbers.join(', ')})`)
    else unknown.push(`${value} ${MISSING_MEASURE}`)
  }
  for (const dim of query.dims) {
    if (own.dims.includes(dim)) matched.push(dim)
    else if (own.dims.length || theirNumbers.length || own.ruling) conflicts.push(`${dim} no coincide`)
    else unknown.push(`${dim} ${MISSING_MEASURE}`)
  }
  // Ruling conventions (catalogConventions.ts): # = cuadriculado, 1x1/2x2 = cuadrimax.
  const ruling = rulingOf(query)
  if (ruling) {
    const theirs = rulingOf(own)
    if (theirs === ruling) matched.push(ruling)
    // Cuadrimax is a kind of grid: compatible with «cuadriculado», but not confirmed.
    else if (ruling === 'cuadriculado' && theirs === 'cuadrimax') unknown.push('cuadriculado ≈ cuadrimax no confirmado')
    else if (theirs) conflicts.push(`pide ${ruling} y el producto es ${theirs}`)
    else unknown.push(`${ruling} no confirmado`)
  }
  if (query.size) {
    if (!own.size) unknown.push(`${query.size.label.toUpperCase()} no confirmado`)
    else if (own.size.label === query.size.label) matched.push(query.size.label)
    // Same group but different words (A4 vs «grande»): compatible, not confirmed.
    else if (own.size.group === query.size.group) unknown.push(`${query.size.label.toUpperCase()} ≈ ${own.size.label} no confirmado`)
    else conflicts.push(`pide ${query.size.label} y el producto es ${own.size.label}`)
  }
  return { doc, coverage, matched, unknown, conflicts, extra, learned }
}

const RRF_K = 60
// Exact-signal tuple used to detect ties. An exact product name is NOT a tie-breaker: if two active
// products match what the order says, the line is ambiguous (policy: register only what is unequivocal).
const tupleOf = (c: RankedCandidate) => [c.learned ? 1 : 0, c.conflicts.length ? 0 : 1, Number(c.coverage.toFixed(3)), c.matched.length, -c.unknown.length]
// Ordering only: prefer the exact name as the preselected option.
const orderOf = (c: RankedCandidate) => [...tupleOf(c), c.extra === 0 ? 1 : 0]
const compareTuples = (a: number[], b: number[]) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return b[i] - a[i]
  return 0
}

/**
 * Ranks retrieved candidates and decides confidence.
 * high   = exactly one candidate without conflicts that covers every word of the order and
 *          beats all others on exact signals (not just on similarity).
 * medium = a probable candidate exists, but there is a tie or a doubt.
 * low    = nothing compatible.
 */
export const decideMatch = (queryText: string, retrieved: RetrievedDoc[], brands: Set<string>): MatchDecision => {
  queryText = applyConventions(queryText)
  const normalizedQuery = normalizeText(queryText)
  const query = parseAttributes(queryText, true)
  const type = lineType(query, retrieved)
  const ranked = retrieved.map((doc, index): RankedCandidate => {
    const retrieval = (doc.lexical_rank ? 1 / (RRF_K + doc.lexical_rank) : 0) + (doc.vector_rank ? 1 / (RRF_K + doc.vector_rank) : 0) +
      (!doc.lexical_rank && !doc.vector_rank ? 1 / (RRF_K + index + 1) : 0)
    const scored = scoreCandidate(query, doc, brands, normalizedQuery, type)
    const attrTotal = scored.matched.length + scored.unknown.length + scored.conflicts.length
    const attrScore = attrTotal ? scored.matched.length / attrTotal : 1
    const score = (0.5 * scored.coverage + 0.3 * attrScore + 0.2 * Math.min(1, retrieval * RRF_K / 1.2)) * (scored.conflicts.length ? 0.4 : 1)
    return { ...scored, retrieval, score: Number(score.toFixed(4)) }
  }).sort((a, b) => compareTuples(orderOf(a), orderOf(b)) || b.score - a.score)

  const eligible = ranked.filter(c => !c.conflicts.length && (c.coverage >= 0.6 || c.learned))
  const doubts: string[] = []
  if (!query.words.length && !allNumbers(query).length) {
    return { confidence: 'low', best: null, ranked, doubts: ['El pedido no describe un producto.'] }
  }
  if (!eligible.length) {
    const closest = closestCandidates(ranked)[0]
    doubts.push(closest
      ? `No hay un producto que coincida exactamente; el más parecido es ${closest.doc.name}${closest.conflicts.length ? ` (${closest.conflicts.join('; ')})` : ''}.`
      : 'No encontré ese producto en el catálogo.')
    return { confidence: 'low', best: null, ranked, doubts }
  }
  const [best, second] = eligible
  const tied = second && compareTuples(tupleOf(best), tupleOf(second)) === 0
  if (tied) doubts.push(`Hay varios productos igual de compatibles: ${eligible.filter(c => compareTuples(tupleOf(best), tupleOf(c)) === 0).slice(0, 5).map(c => c.doc.name + (c.doc.brand ? ` / ${c.doc.brand}` : '')).join('; ')}.`)
  if (best.coverage < 1 && !best.learned) doubts.push(`No todas las palabras del pedido aparecen en ${best.doc.name}.`)
  if (best.unknown.length > 1) doubts.push(`Sin confirmar en ${best.doc.name}: ${best.unknown.join('; ')}.`)
  // A size/ruling the name omits is tolerated; a number or measure it omits is not.
  const missingMeasures = best.unknown.filter(u => u.endsWith(MISSING_MEASURE))
  const numericUnknown = missingMeasures.length > 0
  if (numericUnknown) doubts.push(`${best.doc.name} no indica la medida pedida: ${missingMeasures.join('; ')}.`)
  const high = !tied && (best.learned || (best.coverage === 1 && best.unknown.length <= 1 && !numericUnknown))
  return { confidence: high ? 'high' : 'medium', best, ranked, doubts }
}

/** Most similar candidates even with conflicts (e.g. «tenemos Markin, pero de 100 hojas»). */
export const closestCandidates = (ranked: RankedCandidate[], minCoverage = 0.6) => ranked
  .filter(c => c.coverage >= minCoverage || c.learned)
  .sort((a, b) => b.coverage - a.coverage || a.conflicts.length - b.conflicts.length || b.score - a.score)

/** Candidates exactly as compatible as the best one (a real tie). */
export const tiedWithBest = (decision: MatchDecision) => decision.best
  ? decision.ranked.filter(c => !c.conflicts.length && compareTuples(tupleOf(c), tupleOf(decision.best!)) === 0)
  : []

export const reasonsFor = (candidate: RankedCandidate) => [
  ...(candidate.learned ? ['coincide con un sinónimo aprendido'] : []),
  `${Math.round(candidate.coverage * 100)}% de las palabras del pedido coinciden`,
  ...candidate.matched.map(value => `${value} coincide`),
  ...candidate.unknown,
  ...candidate.conflicts
]

/** Lexical retrieval over an in-memory list (fallback when the hybrid RPC is not installed, and for evaluation). */
export const retrieveLexical = (queryText: string, docs: SearchDoc[], limit = 40): RetrievedDoc[] => {
  const query = parseAttributes(applyConventions(queryText), true)
  const queryNumbers = allNumbers(query)
  return docs.map(doc => {
    const words = [...parseAttributes(docText(doc)).words, ...(doc.synonyms || []).flatMap(s => parseAttributes(s).words)]
    const covered = query.words.filter(word => wordPresent(word, words)).length
    const numbers = allNumbers(parseAttributes(docText(doc)))
    const numeric = queryNumbers.filter(n => numbers.some(m => sameNumber(n, m))).length
    return { doc, value: covered * 2 + numeric }
  }).filter(r => r.value > 0).sort((a, b) => b.value - a.value).slice(0, limit)
    .map((r, i) => ({ ...r.doc, lexical_rank: i + 1 }))
}

/** Reciprocal rank fusion of two ranked lists (by id). */
export const fuseRanks = (lexical: RetrievedDoc[], vector: RetrievedDoc[], limit = 40): RetrievedDoc[] => {
  const byId = new Map<string, RetrievedDoc>()
  lexical.forEach((doc, i) => byId.set(doc.id, { ...doc, lexical_rank: doc.lexical_rank ?? i + 1 }))
  vector.forEach((doc, i) => byId.set(doc.id, { ...(byId.get(doc.id) || doc), vector_rank: doc.vector_rank ?? i + 1, vector_similarity: doc.vector_similarity ?? null }))
  const rrf = (d: RetrievedDoc) => (d.lexical_rank ? 1 / (RRF_K + d.lexical_rank) : 0) + (d.vector_rank ? 1 / (RRF_K + d.vector_rank) : 0)
  return [...byId.values()].sort((a, b) => rrf(b) - rrf(a)).slice(0, limit)
}
