/**
 * Catalog conventions of the store, in ONE place (easy to extend).
 *
 * How products are written in the catalog vs how sellers say them. The matcher
 * (productSearch.ts) and the context layer (productContext.ts) read only from here.
 * Learned, product-specific synonyms do NOT go here: they come from sales reviews
 * (table product_search_synonyms, source='sale_review').
 */

/** Phrases rewritten before searching (the seller's words → the catalog's word). */
export const PHRASE_REWRITES: Array<[RegExp, string]> = [
  // «goma de borrar» is an eraser (Borrador), not glue (Goma en barra).
  [/\bgomas?\s+(?:de|para)\s+borrar\b/g, 'borrador'],
  [/\bborradores?\s+de\s+goma\b/g, 'borrador']
]

/** Word-level equivalences (each key also matches its values and vice versa). */
export const SYNONYMS: Record<string, string[]> = {
  tajador: ['sacapunta', 'sacapuntas', 'tarjador'],
  bond: ['boom', 'bon'],
  boligrafo: ['lapicero'],
  renglon: ['reglon'],
  plumon: ['marcador'],
  silicona: ['silicon'],
  cuaderno: ['cuad', 'cuader'],
  folder: ['folders', 'carpeta'],
  cinta: ['scotch', 'scosh', 'scoth', 'tape'],
  engrapador: ['engrapadora', 'grapadora', 'engrampador'],
  crayones: ['crayolas'],
  masking: ['maskin'],
  posit: ['post-it', 'postit'],
  rompecabezas: ['puzzle']
}

/**
 * Ruling of notebooks and paper:
 *   «#» = cuadriculado (normalizeText rewrites # as cuadriculado)
 *   «triple renglón / reglón» = tres rayas (parsed as 'triple')
 *   «1x1» / «2x2» = cuadrimax
 *   «rayado»
 */
export const RULING_WORDS: Array<[RegExp, string]> = [
  [/^(cuadriculado|cuadriculada|cuadricula|cuadriculados|cuadros|cuadrito|cuadritos)$/, 'cuadriculado'],
  [/^(rayado|rayada|rayados|rayas|raya|rayita)$/, 'rayado'],
  [/^(cuadrimax)$/, 'cuadrimax']
]
/** Dimensions that mean «cuadrimax» on a notebook (cuaderno surco 1x1, stanford 2x2). */
export const CUADRIMAX_DIMS = new Set(['1x1', '2x2'])

/** Sizes: same group = compatible but not confirmed (A4 ≈ grande); different group = conflict. */
export const SIZE_WORDS: Array<[RegExp, string, string]> = [
  [/^a4$/, 'a4', 'large'], [/^(grande|grandes)$/, 'grande', 'large'], [/^(oficio)$/, 'oficio', 'large'],
  [/^a5$/, 'a5', 'small'], [/^(pequeno|pequenos|pequena|pequenas|chico|chica|pq)$/, 'pequeño', 'small'],
  [/^(mediano|mediana)$/, 'mediano', 'medium'], [/^a3$/, 'a3', 'xlarge']
]

/** Applies the phrase conventions to a raw order line (idempotent). */
export const applyConventions = (text: string) => {
  let out = text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  for (const [pattern, replacement] of PHRASE_REWRITES) out = out.replace(pattern, replacement)
  return out
}

/**
 * Sound-alike key for dictated words (Spanish speech-to-text), for brands AND features:
 * marking / markin / margen → «markin» (masking stays different); pisar / pizarra → «pisar».
 * Only used for words of 5+ letters.
 */
export const phoneticKey = (word: string) => word
  .replace(/ng$/, 'n')
  .replace(/ch/g, 'x')
  .replace(/qu/g, 'k')
  .replace(/c(?=[eiy])/g, 's')
  .replace(/[cgq]/g, 'k')
  .replace(/z/g, 's')
  .replace(/v/g, 'b')
  .replace(/ll/g, 'y')
  .replace(/h/g, '')
  .replace(/e/g, 'i')
  .replace(/o/g, 'u')
  .replace(/(.)\1+/g, '$1')
  // A dropped/added final vowel is a common dictation error: «para pisar» ≈ pizarra.
  .replace(/[aiu]$/, '')
