/**
 * Grounding checks (deterministic): a value proposed by the AI may decide a DIRECT sale only if the
 * seller actually wrote it — and, in orders with several lines, wrote it FOR THAT LINE. `text` is the
 * seller's own messages of this conversation (never a text produced by the AI).
 */

// Voice dictation writes «un sol» as «$1»: «$» is read as soles (same as «s/»).
export const normalizeText = (text: string) => ` ${text.replace(/\$/g, ' s ').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/(\d),(\d)/g, '$1.$2').replace(/[^a-z0-9.\s]/g, ' ').replace(/\.(?!\d)/g, ' ').replace(/\s+/g, ' ').trim()} `
const tokens = (text: string) => normalizeText(text).trim().split(' ').filter(Boolean)

// ------------------------------------------------------------------------------------- payment

/** Usual ways of naming each payment method in Peru (keyed by normalized code or label). */
const PAYMENT_ALIASES: Record<string, string[]> = {
  efectivo: ['efectivo', 'cash', 'contado', 'al contado', 'en efectivo', 'sencillo'],
  yape: ['yape', 'yapeo', 'yapea', 'yapear', 'por yape'],
  plin: ['plin', 'plinea', 'por plin'],
  tarjeta: ['tarjeta', 'visa', 'mastercard', 'pos', 'debito', 'credito'],
  transferencia: ['transferencia', 'deposito', 'transferido', 'depositado']
}
const NEGATIONS = new Set(['no', 'sin', 'ni', 'tampoco'])

/** Start indexes of `phrase` (already tokenized) inside `words`. */
const occurrences = (words: string[], phrase: string[]) => {
  const found: number[] = []
  for (let i = 0; i + phrase.length <= words.length; i++) if (phrase.every((w, j) => words[i + j] === w)) found.push(i)
  return found
}

/**
 * True if the seller's text names this payment method (code, label or a known alias) WITHOUT an
 * immediate negation: «yape no, efectivo», «no es yape», «sin tarjeta» do not count for that method.
 */
export const paymentMentioned = (text: string, method: { code: string; label: string }) => {
  // A negation applies within its clause: in «yape no, efectivo» the «no» is about yape only.
  const clauses = text.split(/[,;:\n]|\.(?!\d)/).map(tokens).filter(c => c.length)
  const keys = [method.code, method.label].map(value => normalizeText(value).trim())
  const phrases = [method.code, method.label, ...keys.flatMap(key => [...(PAYMENT_ALIASES[key] || []), ...(PAYMENT_ALIASES[key.split(' ')[0]] || [])])]
    .map(tokens).filter(p => p.length)
  return clauses.some(words => phrases.some(phrase => occurrences(words, phrase).some(start => {
    const before = words.slice(Math.max(0, start - 3), start)
    const after = words[start + phrase.length] || ''
    const negatedBefore = NEGATIONS.has(before[before.length - 1] || '') ||
      // «no es yape», «no con yape», «no por yape», «no en efectivo»
      (NEGATIONS.has(before[before.length - 2] || '') && ['es', 'con', 'por', 'en', 'sera', 'era'].includes(before[before.length - 1] || ''))
    return !negatedBefore && after !== 'no'
  })))
}

export type PaymentMethodRow = { code: string; label: string }
export type PaymentChoice =
  | { kind: 'said'; method: PaymentMethodRow }
  | { kind: 'default'; method: PaymentMethodRow }
  | { kind: 'ambiguous'; methods: PaymentMethodRow[] }
  | { kind: 'unavailable'; said: string }
  | { kind: 'no_default' }

const methodKey = (method: PaymentMethodRow) => {
  const keys = [method.code, method.label].map(value => tokens(value).join(' '))
  return keys.find(key => key in PAYMENT_ALIASES) || keys.map(key => key.split(' ')[0]).find(key => key in PAYMENT_ALIASES) || keys[0]
}
/** Payment names the seller wrote (not negated), by alias family (efectivo, yape, plin, tarjeta, transferencia). */
const paymentFamiliesSaid = (text: string) => Object.keys(PAYMENT_ALIASES).filter(key => paymentMentioned(text, { code: key, label: key }))

/**
 * Payment rule (owner, 2026-11-16): «por defecto va a ser efectivo; si el vendedor te dice pago por
 * transferencia, ahí recién registres eso». Only the seller's text decides, never the AI:
 *  - one method said (not negated) → that one, if it exists in the POS;
 *  - a method said that the POS does not have → unavailable (review);
 *  - several different methods said → ambiguous (review);
 *  - none said → efectivo by default (an AI proposal the seller did not say is ignored).
 */
export const choosePayment = (text: string, methods: PaymentMethodRow[]): PaymentChoice => {
  const saidMethods = methods.filter(method => paymentMentioned(text, method))
  const covered = new Set(saidMethods.map(methodKey))
  const missing = paymentFamiliesSaid(text).filter(family => !covered.has(family))
  if (missing.length) return { kind: 'unavailable', said: missing[0] }
  const distinct = [...new Map(saidMethods.map(m => [m.code, m])).values()]
  if (distinct.length > 1) return { kind: 'ambiguous', methods: distinct }
  if (distinct.length === 1) return { kind: 'said', method: distinct[0] }
  const cash = methods.find(method => methodKey(method) === 'efectivo')
  return cash ? { kind: 'default', method: cash } : { kind: 'no_default' }
}

// ------------------------------------------------------------------------------------- numbers

const WORD_NUMBERS: Record<string, number> = {
  un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8,
  nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, veinte: 20,
  dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veintiuno: 21, veintidos: 22,
  veintitres: 23, veinticuatro: 24, veinticinco: 25, treinta: 30, cuarenta: 40, cincuenta: 50,
  sesenta: 60, setenta: 70, ochenta: 80, noventa: 90, cien: 100, ciento: 100, doscientos: 200,
  trescientos: 300, quinientos: 500, mil: 1000
}
const TENS = new Set(['treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'])
const UNITS = new Set(['uno', 'un', 'una', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve'])
/** Counting words: «una docena» = 12 units or 1 dozen; «un par» = 2; «una decena» = 10. */
const MULTIPLIERS: Record<string, { factor: number; presentation: string | null }> = {
  docena: { factor: 12, presentation: 'docena' }, docenas: { factor: 12, presentation: 'docena' },
  par: { factor: 2, presentation: null }, pares: { factor: 2, presentation: null },
  decena: { factor: 10, presentation: null }, decenas: { factor: 10, presentation: null }
}
/** Value of the number that starts at `index` ("35", "treinta y cinco", "dos") and where it ends. */
const numberAt = (words: string[], index: number): { value: number; end: number } | null => {
  const word = words[index]
  if (!word) return null
  if (/^\d+(\.\d+)?$/.test(word)) return { value: Number(word), end: index }
  if (TENS.has(word) && words[index + 1] === 'y' && UNITS.has(words[index + 2] || '')) {
    return { value: WORD_NUMBERS[word] + WORD_NUMBERS[words[index + 2]], end: index + 2 }
  }
  return word in WORD_NUMBERS ? { value: WORD_NUMBERS[word], end: index } : null
}

/** Words after a number that make it part of the product description, not the quantity. */
const ATTRIBUTE_WORDS = new Set([
  'hoja', 'hojas', 'h', 'cm', 'mm', 'm', 'mt', 'mts', 'metro', 'metros', 'ml', 'l', 'lt', 'litro', 'litros',
  'g', 'gr', 'grs', 'gramo', 'gramos', 'kg', 'kilo', 'kilos', 'pulgada', 'pulgadas', 'x', 'por', 'color',
  'colores', 'pliegos', 'pliego', 'paginas', 'pag', 'micras', 'oz', 'w', 'v', 'mah', 'gb', 'piezas', 'pzs',
  'anos', 'ano', 'grado', 'grados', 'puntas', 'tonos', 'lineas', 'renglones', 'raya', 'rayas', 'cuadros'
])
/** Words around a number that make it an amount of money. */
const MONEY_AFTER = new Set(['sol', 'soles', 'pen', 'lucas', 'luca', 'nuevos', 'nuevo'])
const isMoneyAt = (words: string[], index: number, end = index) => {
  const previous = words[index - 1] || ''
  const before = words[index - 2] || ''
  const next = words[end + 1] || ''
  return previous === 's' || MONEY_AFTER.has(next) ||
    // "a 3.50" / "por 12.90": an amount with cents after a price preposition.
    (['a', 'por', 'en'].includes(previous) && /^\d+\.\d{1,2}$/.test(words[index])) ||
    // What the customer paid with or the change: «pagó con 50», «paga con 20», «vuelto de 5», «billete de 100».
    (previous === 'con' && /^pag/.test(before)) || previous === 'vuelto' ||
    (previous === 'de' && ['vuelto', 'billete', 'sencillo'].includes(before))
}

/**
 * A quantity the seller wrote. `units` = how many base units it means; `dozens` = how many dozens
 * when the phrase was about dozens («una docena» → units 12 / dozens 1; «media docena» → 6 / 0.5).
 */
export type QuantityMention = { start: number; end: number; units: number; dozens: number | null }

const quantityMentionsIn = (words: string[]): QuantityMention[] => {
  const found: QuantityMention[] = []
  for (let index = 0; index < words.length; index++) {
    const word = words[index]
    if (word === 'media' && (words[index + 1] === 'docena' || words[index + 1] === 'docenas')) {
      found.push({ start: index, end: index + 1, units: 6, dozens: 0.5 }); index++; continue
    }
    const number = numberAt(words, index)
    if (!number) {
      // A counting word without a number: «docena de lapiceros» = 1 dozen, «par de medias» = 2.
      const multiplier = MULTIPLIERS[word]
      if (multiplier && !numberAt(words, index - 1)) {
        found.push({ start: index, end: index, units: multiplier.factor, dozens: multiplier.presentation ? 1 : null })
      }
      continue
    }
    const next = words[number.end + 1] || ''
    if (isMoneyAt(words, index, number.end)) { index = number.end; continue }
    const multiplier = MULTIPLIERS[next]
    if (multiplier) {
      found.push({ start: index, end: number.end + 1, units: number.value * multiplier.factor, dozens: multiplier.presentation ? number.value : null })
      index = number.end + 1
      continue
    }
    // Descriptions ("100 hojas") are not quantities.
    if (!ATTRIBUTE_WORDS.has(next)) found.push({ start: index, end: number.end, units: number.value, dozens: null })
    index = number.end
  }
  return found
}

/** Value of a mention in the presentation of the line (dozens only when the line is sold by dozen). */
const valueIn = (mention: QuantityMention, dozenPresentation: boolean) =>
  mention.dozens !== null && dozenPresentation ? mention.dozens : mention.units

/** Quantities the seller wrote, counted per value (in base units). Kept for callers and tests. */
export const quantityMentions = (text: string) => {
  const counts = new Map<number, number>()
  for (const m of quantityMentionsIn(tokens(text))) counts.set(m.units, (counts.get(m.units) || 0) + 1)
  return counts
}

/**
 * The AI sometimes leaves the quantity inside the product description ("dos cuadernos marking…").
 * A number at the START of the description (not followed by an attribute: "100 hojas bond" keeps it)
 * is the quantity, not part of the product, so it is removed before comparing.
 */
export const descriptionWithoutQuantity = (description: string) => {
  const words = tokens(description)
  let start = 0
  if (words[0] === 'media' && words[1] === 'docena') start = 2
  else if (MULTIPLIERS[words[0]]) start = 1
  else {
    const found = numberAt(words, 0)
    if (found && !ATTRIBUTE_WORDS.has(words[found.end + 1] || '')) {
      start = found.end + 1
      if (MULTIPLIERS[words[start]]) start++
    }
  }
  if (start && words[start] === 'de') start++
  return start ? words.slice(start).join(' ') : description
}

/** Every number written in a text, descriptions included ("cuaderno 100 hojas a4" → 100, 4). */
const allNumbers = (text: string) => {
  const values = new Set<number>()
  for (const word of tokens(text)) {
    if (/^\d+(\.\d+)?$/.test(word)) values.add(Number(word))
    for (const match of word.matchAll(/\d+/g)) values.add(Number(match[0])) // a4 → 4
  }
  return values
}

type MoneyMention = { start: number; end: number; value: number }
const moneyMentionsIn = (words: string[]): MoneyMention[] => {
  const found: MoneyMention[] = []
  for (let index = 0; index < words.length; index++) {
    const number = numberAt(words, index)
    if (!number) continue
    if (isMoneyAt(words, index, number.end)) found.push({ start: index, end: number.end, value: number.value })
    index = number.end
  }
  return found
}
/** Amounts of money the seller wrote ("a 3 soles", "s/ 3.50", "por 10 soles", "un sol", "$4"). */
export const moneyMentions = (text: string) => moneyMentionsIn(tokens(text)).map(m => m.value)

// ------------------------------------------------------------------------- attribution to lines

const STOPWORDS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'con', 'para', 'y', 'a', 'en', 'por', 'x', 'un', 'una', 'al', 'o'])
const stem = (word: string) => word.length > 4 && word.endsWith('es') ? word.slice(0, -2) : word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word
const sameWord = (a: string, b: string) => {
  const x = stem(a), y = stem(b)
  return x === y || (x.length >= 5 && y.length >= 5 && x.slice(0, 5) === y.slice(0, 5))
}
/** Words that identify a line in the seller's text (its product description without quantity). */
const anchorsOf = (query: string) => [...new Set(tokens(descriptionWithoutQuantity(query))
  .filter(w => !STOPWORDS.has(w) && !/^\d+(\.\d+)?$/.test(w) && !(w in WORD_NUMBERS) && !MULTIPLIERS[w]))]

/** Lines whose words appear in `window`, best first (more distinct anchors); [] if none. Ties are all returned. */
const bestLines = (window: string[], anchors: string[][]) => {
  const scores = anchors.map(own => own.filter(anchor => window.some(word => sameWord(word, anchor))).length)
  const best = Math.max(0, ...scores)
  return best ? scores.flatMap((score, i) => score === best ? [i] : []) : []
}
const WINDOW = 6

export type OrderLine = { quantity: number | null; query: string; unit: string | null }
export type LineEvidence = {
  /** Quantities written for this line (mentions), minus the numbers of its own description. */
  quantities: QuantityMention[]
  /** Amounts of money written for this line. */
  amounts: number[]
}
export type OrderEvidence = { lines: LineEvidence[]; unassignedQuantities: QuantityMention[] }

/**
 * Which quantities and amounts the seller wrote for each line. One line: everything is its own.
 * Several lines: a quantity belongs to the line whose words FOLLOW it («2 lapiceros y 3 cuadernos»),
 * an amount to the line whose words PRECEDE it («un lapicero a 1 sol y un cuaderno a 5 soles»);
 * each written number is used once; a number that cannot be attributed stays unassigned.
 */
export const analyzeOrder = (text: string, lines: OrderLine[]): OrderEvidence => {
  const words = tokens(text)
  const quantities = quantityMentionsIn(words)
  const amounts = moneyMentionsIn(words)
  const evidence: LineEvidence[] = lines.map(() => ({ quantities: [], amounts: [] }))
  const unassigned: QuantityMention[] = []
  if (lines.length <= 1) {
    if (lines.length) evidence[0] = { quantities, amounts: amounts.map(a => a.value) }
  } else {
    const anchors = lines.map(line => anchorsOf(line.query))
    const boundary = (w: string) => w === 'y' || w === 'mas'
    for (const q of quantities) {
      const window: string[] = []
      for (let i = q.end + 1; i < words.length && window.length < WINDOW; i++) {
        if (boundary(words[i]) || quantities.some(other => other.start === i)) break
        window.push(words[i])
      }
      // Tied lines (same product twice: «una docena de cuadernos y 10 cuadernos sueltos») take the
      // numbers in order of appearance: the first tied line still without a quantity.
      const line = bestLines(window, anchors).find(i => !evidence[i].quantities.length)
      if (line === undefined) unassigned.push(q)
      else evidence[line].quantities.push(q)
    }
    for (const a of amounts) {
      const window: string[] = []
      for (let i = a.start - 1; i >= 0 && window.length < WINDOW; i--) {
        if (boundary(words[i]) || amounts.some(other => other.end === i)) break
        window.push(words[i])
      }
      const line = bestLines(window, anchors).find(i => !evidence[i].amounts.length)
      if (line !== undefined) evidence[line].amounts.push(a.value)
    }
  }
  // Numbers of the line's own description are not quantities ("cuaderno a4 100" → 100 is the product).
  lines.forEach((line, i) => {
    const description = quantityMentionsIn(tokens(descriptionWithoutQuantity(line.query)))
    for (const d of description) {
      const at = evidence[i].quantities.findIndex(q => q.units === d.units && q.dozens === d.dozens)
      if (at >= 0) evidence[i].quantities.splice(at, 1)
    }
  })
  return { lines: evidence, unassignedQuantities: unassigned }
}

// ------------------------------------------------------------------------------- decisions

const DOZEN = /docena/
export type QuantityDecision =
  | { ok: true; quantity: number; defaulted: boolean; inferred?: boolean }
  | { ok: false; reason: 'ungrounded' | 'unassigned' }

/**
 * Quantity rule ("si no se dice cantidad es 1"), per line:
 *  - the quantity the seller wrote FOR THIS LINE (in its presentation: «una docena» is 1 if sold by
 *    the dozen, 12 if sold by unit) is used as is;
 *  - no quantity written for the line → 1, also when the AI took a number from the description;
 *  - the AI gave none but exactly one was written for the line → that one ("dos cuadernos" → 2);
 *  - anything else (an AI quantity not written for this line, several candidates, a number that
 *    cannot be attributed) → review, never a silent 1.
 */
export const decideQuantity = (evidence: OrderEvidence, index: number, line: OrderLine): QuantityDecision => {
  const dozenPresentation = DOZEN.test(normalizeText(line.unit || ''))
  const written = evidence.lines[index].quantities.map(m => valueIn(m, dozenPresentation))
  if (line.quantity !== null && written.includes(line.quantity)) return { ok: true, quantity: line.quantity, defaulted: false }
  const meaningful = written.filter(v => v !== 1)
  const unassigned = evidence.unassignedQuantities.some(m => m.units !== 1)
  // Inferred only when nothing else could be the quantity («tres o cuatro cuadernos» → review).
  if (line.quantity === null && meaningful.length === 1 && written.length === 1 && !unassigned) {
    return { ok: true, quantity: meaningful[0], defaulted: false, inferred: true }
  }
  if (meaningful.length || unassigned) return { ok: false, reason: line.quantity === null ? 'unassigned' : 'ungrounded' }
  if (line.quantity === null || line.quantity === 1 || allNumbers(descriptionWithoutQuantity(line.query)).has(line.quantity)) {
    return { ok: true, quantity: 1, defaulted: true }
  }
  return { ok: false, reason: 'ungrounded' }
}

/**
 * A dictated unit price counts only if the seller wrote it as money FOR THIS LINE: the unit price
 * itself ("a 3 soles") or the line total ("2 cuadernos por 6 soles" → 3 each).
 */
export const priceGroundedFor = (evidence: OrderEvidence, index: number, unitPrice: number, quantity: number) =>
  evidence.lines[index].amounts.some(amount => Math.abs(amount - unitPrice) <= 0.005 || Math.abs(amount - unitPrice * quantity) <= 0.01)

/** Presentations and how the seller says them. */
const UNIT_ALIASES: Record<string, string[]> = {
  caja: ['caja', 'cajas', 'cajita', 'cajitas'], docena: ['docena', 'docenas'],
  paquete: ['paquete', 'paquetes', 'paq', 'pack', 'packs'], ciento: ['ciento', 'cientos'],
  millar: ['millar', 'millares'], resma: ['resma', 'resmas'], blister: ['blister', 'blisters'],
  bolsa: ['bolsa', 'bolsas'], sobre: ['sobre', 'sobres'], rollo: ['rollo', 'rollos'],
  juego: ['juego', 'juegos'], par: ['par', 'pares'], decena: ['decena', 'decenas'], tira: ['tira', 'tiras']
}
const BASE_UNITS = new Set(['unidad', 'unidades', 'und', 'u', 'un', 'pza', 'pieza'])
/** A presentation other than the base unit counts only if the seller said it («2 cajas», «una docena»). */
export const unitGrounded = (text: string, unit: string | null, baseUnit: string) => {
  if (!unit) return true
  const wanted = tokens(unit).join(' ')
  if (!wanted || BASE_UNITS.has(wanted) || wanted === tokens(baseUnit).join(' ')) return true
  const words = tokens(text)
  const aliases = UNIT_ALIASES[wanted] || [wanted, `${wanted}s`, `${wanted}es`]
  return aliases.some(alias => occurrences(words, tokens(alias)).length > 0)
}

/** Presentations that are counted in whole units (no "0.5 lapiceros"); a dozen allows halves. */
const WHOLE_UNITS = new Set(['unidad', 'und', 'u', 'pieza', 'pza', 'caja', 'paquete', 'ciento', 'millar', 'blister', 'sobre', 'bolsa', 'rollo', 'juego', 'par', 'resma', 'tira'])
export const quantityFitsUnit = (quantity: number, unitName: string) => {
  const unit = tokens(unitName).join(' ')
  if (DOZEN.test(unit)) return Number.isInteger(quantity * 2)
  if (WHOLE_UNITS.has(unit)) return Number.isInteger(quantity)
  return true // measures (metro, kg, litro…) may be fractional
}

// ------------------------------------------------------------- single-line helpers (compat/tests)

const single = (quantity: number | null, description: string, unit: string | null = null): OrderLine => ({ quantity, query: description, unit })

/** Was this quantity written for a one-line order (descriptions excluded)? */
export const quantityGrounded = (text: string, quantity: number, description: string) => {
  const line = single(quantity, description)
  // Without a presentation, «una docena» may be 1 (dozen) or 12 (units).
  return analyzeOrder(text, [line]).lines[0].quantities.some(m => valueIn(m, false) === quantity || valueIn(m, true) === quantity)
}

/** One-line quantity decision (`others` and `singleLine` kept for compatibility; multi-line uses analyzeOrder). */
export const resolveQuantity = (
  text: string, quantity: number | null, description: string, _others: number[] = [],
  options: { singleLine?: boolean; unit?: string | null } = {}
): QuantityDecision => {
  const line = single(quantity, description, options.unit ?? null)
  return decideQuantity(analyzeOrder(text, [line]), 0, line)
}

/** One-line price check. */
export const priceGrounded = (text: string, unitPrice: number, quantity: number) => {
  const line = single(quantity, '')
  return priceGroundedFor(analyzeOrder(text, [line]), 0, unitPrice, quantity)
}
