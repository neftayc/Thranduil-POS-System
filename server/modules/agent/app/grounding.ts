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
  treinta: [30], cuarenta: [40], cincuenta: [50], cien: [100], ciento: [100], par: [2], decena: [10],
  docena: [1, 12], media: [0.5]
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
  for (const [index, word] of words.entries()) {
    const next = words[index + 1] || ''
    if (ATTRIBUTE_WORDS.has(next)) continue
    if (/^\d+(\.\d+)?$/.test(word)) add(Number(word))
    else if (word === 'media' && next === 'docena') { add(0.5); add(6) }
    else if (word === 'docena' && words[index - 1] === 'media') continue
    else if (WORD_NUMBERS[word]) WORD_NUMBERS[word].forEach(add)
  }
  return counts
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
