/**
 * Grounding checks (deterministic): a value proposed by the AI may decide a DIRECT sale only if the
 * seller actually wrote it. `text` is the seller's own messages of this conversation (never a text
 * produced by the AI).
 */

export const normalizeText = (text: string) => ` ${text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/(\d),(\d)/g, '$1.$2').replace(/[^a-z0-9.\s]/g, ' ').replace(/\.(?!\d)/g, ' ').replace(/\s+/g, ' ').trim()} `

const has = (haystack: string, phrase: string) => {
  const needle = normalizeText(phrase).trim()
  return Boolean(needle) && haystack.includes(` ${needle} `)
}

/** Usual ways of naming each payment method in Peru (keyed by normalized code or label). */
const PAYMENT_ALIASES: Record<string, string[]> = {
  efectivo: ['efectivo', 'cash', 'contado', 'al contado', 'en efectivo', 'sencillo'],
  yape: ['yape', 'yapeo', 'yapea', 'yapear', 'por yape'],
  plin: ['plin', 'plinea', 'por plin'],
  tarjeta: ['tarjeta', 'visa', 'mastercard', 'pos', 'debito', 'credito'],
  transferencia: ['transferencia', 'deposito', 'transferido', 'depositado']
}

/** True if the seller's text names this payment method (code, label or a known alias). */
export const paymentMentioned = (text: string, method: { code: string; label: string }) => {
  const haystack = normalizeText(text)
  const keys = [method.code, method.label].map(value => normalizeText(value).trim())
  const phrases = [method.code, method.label, ...keys.flatMap(key => [...(PAYMENT_ALIASES[key] || []), ...(PAYMENT_ALIASES[key.split(' ')[0]] || [])])]
  return phrases.some(phrase => has(haystack, phrase))
}

const WORD_NUMBERS: Record<string, number[]> = {
  un: [1], uno: [1], una: [1], dos: [2], tres: [3], cuatro: [4], cinco: [5], seis: [6], siete: [7], ocho: [8],
  nueve: [9], diez: [10], once: [11], doce: [12], trece: [13], catorce: [14], quince: [15], veinte: [20],
  dieciseis: [16], diecisiete: [17], dieciocho: [18], diecinueve: [19], veintiuno: [21], veintidos: [22],
  veintitres: [23], veinticuatro: [24], veinticinco: [25], treinta: [30], cuarenta: [40], cincuenta: [50],
  sesenta: [60], setenta: [70], ochenta: [80], noventa: [90], cien: [100], ciento: [100], doscientos: [200],
  trescientos: [300], quinientos: [500], mil: [1000], par: [2], decena: [10], docena: [1, 12], media: [0.5]
}
const TENS = new Set(['treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'])
const UNITS = new Set(['uno', 'un', 'una', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve'])
/** Words around a number that make it an amount of money ("s/ 3", "3 soles", "un sol"). */
const MONEY_AFTER = new Set(['sol', 'soles', 'pen', 'lucas', 'luca', 'nuevos', 'nuevo'])
const isMoneyAt = (words: string[], index: number, end = index) => {
  const previous = words[index - 1] || ''
  const next = words[end + 1] || ''
  return previous === 's' || MONEY_AFTER.has(next) ||
    // "a 3.50" / "por 12.90": an amount with cents after a price preposition.
    (['a', 'por', 'en'].includes(previous) && /^\d+\.\d{1,2}$/.test(words[index]))
}
/** Value of the number that starts at `index` ("35", "treinta y cinco", "dos") and the index where it ends. */
const numberAt = (words: string[], index: number): { values: number[]; end: number } | null => {
  const word = words[index]
  if (/^\d+(\.\d+)?$/.test(word)) return { values: [Number(word)], end: index }
  if (TENS.has(word) && words[index + 1] === 'y' && UNITS.has(words[index + 2] || '')) {
    return { values: [WORD_NUMBERS[word][0] + WORD_NUMBERS[words[index + 2]][0]], end: index + 2 }
  }
  return WORD_NUMBERS[word] ? { values: WORD_NUMBERS[word], end: index } : null
}
/** Words after a number that make it part of the product description, not the quantity. */
const ATTRIBUTE_WORDS = new Set([
  'hoja', 'hojas', 'h', 'cm', 'mm', 'm', 'mt', 'mts', 'metro', 'metros', 'ml', 'l', 'lt', 'litro', 'litros',
  'g', 'gr', 'grs', 'gramo', 'gramos', 'kg', 'kilo', 'kilos', 'pulgada', 'pulgadas', 'x', 'por', 'color',
  'colores', 'pliegos', 'pliego', 'paginas', 'pag', 'micras', 'oz', 'w', 'v', 'mah', 'gb', 'piezas', 'pzs',
  'anos', 'ano', 'grado', 'grados', 'puntas', 'tonos', 'lineas', 'renglones', 'raya', 'rayas', 'cuadros'
])

/**
 * Quantities the seller wrote (numbers or words), excluding numbers that describe the product
 * ("100 hojas", "30 cm", "a4" — a token with letters is never a quantity). Returns a count per value.
 */
export const quantityMentions = (text: string) => {
  const words = normalizeText(text).trim().split(' ').filter(Boolean)
  const counts = new Map<number, number>()
  const add = (value: number) => counts.set(value, (counts.get(value) || 0) + 1)
  for (let index = 0; index < words.length; index++) {
    const word = words[index]
    if (word === 'media' && words[index + 1] === 'docena') { add(0.5); add(6); index++; continue }
    const found = numberAt(words, index)
    if (!found) continue
    const next = words[found.end + 1] || ''
    // Descriptions ("100 hojas") and money ("3 soles", "s/ 3") are not quantities.
    if (!ATTRIBUTE_WORDS.has(next) && !isMoneyAt(words, index, found.end)) found.values.forEach(add)
    index = found.end
  }
  return counts
}

/** Every number written in a text, descriptions included ("cuaderno 100 hojas a4" → 100). */
const allNumbers = (text: string) => {
  const words = normalizeText(text).trim().split(' ').filter(Boolean)
  const values = new Set<number>()
  for (const word of words) {
    if (/^\d+(\.\d+)?$/.test(word)) values.add(Number(word))
    for (const match of word.matchAll(/\d+/g)) values.add(Number(match[0])) // a4 → 4
  }
  return values
}

/** Amounts of money the seller wrote ("a 3 soles", "s/ 3.50", "por 10 soles", "un sol"). */
export const moneyMentions = (text: string) => {
  const words = normalizeText(text).trim().split(' ').filter(Boolean)
  const values: number[] = []
  for (let index = 0; index < words.length; index++) {
    const found = numberAt(words, index)
    if (!found) continue
    if (isMoneyAt(words, index, found.end)) values.push(...found.values)
    index = found.end
  }
  return values
}

/**
 * A dictated unit price counts only if the seller wrote it as money: either the unit price itself
 * ("a 3 soles") or the line total ("2 cuadernos por 6 soles" → 3 each).
 */
export const priceGrounded = (text: string, unitPrice: number, quantity: number) =>
  moneyMentions(text).some(amount => Math.abs(amount - unitPrice) <= 0.005 || Math.abs(amount - unitPrice * quantity) <= 0.01)

export type QuantityDecision =
  | { ok: true; quantity: number; defaulted: boolean }
  | { ok: false; reason: 'ungrounded' | 'unassigned' }

/**
 * Quantity rule ("si no se dice cantidad es 1"):
 *  - a quantity the seller wrote (grounded) is used as is;
 *  - with no quantity written for the line, it is 1 — also when the AI took a number from the
 *    product description ("cuaderno 100 hojas a4" → 1);
 *  - an AI quantity the seller did not write, or a written quantity (≠ 1) that no line claims,
 *    goes to review: it may be an amount the parser does not understand.
 * `others` = quantities proposed for the other lines of the same order.
 */
export const resolveQuantity = (text: string, quantity: number | null, productDescription: string, others: number[] = []): QuantityDecision => {
  if (quantity !== null && quantityGrounded(text, quantity, productDescription)) return { ok: true, quantity, defaulted: false }
  // Written quantities not explained by this line's description nor claimed by other lines.
  const free = new Map(quantityMentions(text))
  for (const [value, n] of quantityMentions(productDescription)) free.set(value, (free.get(value) || 0) - n)
  for (const value of others) if (free.has(value)) free.set(value, free.get(value)! - 1)
  const unexplained = [...free].some(([value, n]) => n > 0 && value !== 1)
  if (unexplained) return { ok: false, reason: quantity === null ? 'unassigned' : 'ungrounded' }
  if (quantity === null || quantity === 1 || allNumbers(productDescription).has(quantity)) return { ok: true, quantity: 1, defaulted: true }
  return { ok: false, reason: 'ungrounded' }
}

/**
 * The quantity is grounded if the seller wrote it MORE times than it appears as a free-standing
 * number in the line's own product description (so "cuaderno a4 100" with quantity 100 is not
 * enough; "100 cuadernos a4 100" is).
 */
export const quantityGrounded = (text: string, quantity: number, productDescription: string) => {
  const written = quantityMentions(text).get(quantity) || 0
  const inDescription = [...quantityMentions(productDescription)].filter(([value]) => value === quantity).reduce((sum, [, n]) => sum + n, 0)
  return written > inDescription
}
