import type { Product } from '../contracts'
import { contentWords, similarWord } from './productSearch'

const plain = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/**
 * The product the seller DETERMINISTICALLY chose in their last message among the options
 * that were offered (numbered in `offered` order), or null.
 *
 * Accepted: an option number («la 2», «opción 3», «#1»; a bare «2» may be a quantity, so it is not), a SKU, or a word that only
 * one offered option has («la de faber»). The AI's product_id alone is never enough: a
 * reply like «con yape» must not turn a preselected product into a sale (finding A2).
 */
export type ChoiceDetail = { id: string; by: 'number' | 'sku' | 'word'; words: string[] }

export const explicitChoice = (message: string | undefined, offered: Product[]): string | null => explicitChoiceDetail(message, offered)?.id ?? null

/**
 * Same as explicitChoice, saying HOW the option was chosen. A choice by option number or SKU is
 * unequivocal; a choice by a word (`by: 'word'`) only distinguishes it among the OFFERED options,
 * so callers must confirm it against the whole catalog before treating it as sure.
 */
export const explicitChoiceDetail = (message: string | undefined, offered: Product[]): ChoiceDetail | null => {
  if (!message?.trim() || !offered.length) return null
  const text = plain(message).trim()
  const chosen = new Set<string>()

  const numbers = new Set<number>()
  for (const m of text.matchAll(/\b(?:opcion|numero|nro)\s*\.?\s*(\d{1,2})\b/g)) numbers.add(Number(m[1]))
  for (const m of text.matchAll(/#\s*(\d{1,2})\b/g)) numbers.add(Number(m[1]))
  const whole = text.match(/^(?:la|el|opcion)\s*(\d{1,2})\s*[.)!]?$/) || text.match(/^(?:la|el)\s+(\d{1,2})\b/)
  if (whole) numbers.add(Number(whole[1]))
  if (numbers.size > 1) return null
  for (const n of numbers) if (offered[n - 1]) chosen.add(offered[n - 1].id)
  const byNumber = chosen.size > 0

  const skuHits = offered.filter(p => p.sku && p.sku.length >= 4 && text.includes(plain(p.sku)))
  if (skuHits.length === 1) chosen.add(skuHits[0].id)
  if (skuHits.length > 1) return null
  const bySku = skuHits.length === 1

  // Distinctive words: present in exactly one offered option (name or brand).
  const words = offered.map(p => ({ id: p.id, words: [...new Set(contentWords(`${p.name} ${p.brand || ''}`))] }))
  const said = contentWords(message)
  const hitWords = new Map<string, string[]>()
  const nameHits = words.filter(({ id, words: own }) => {
    const others = words.filter(w => w.id !== id).flatMap(w => w.words)
    const distinctive = own.filter(word => !others.some(other => similarWord(word, other)))
    const hits = said.filter(s => distinctive.some(word => similarWord(s, word)))
    if (hits.length) hitWords.set(id, hits)
    return hits.length > 0
  })
  if (nameHits.length > 1) return null
  if (nameHits.length === 1) chosen.add(nameHits[0].id)

  if (chosen.size !== 1) return null
  const id = [...chosen][0]
  return { id, by: byNumber ? 'number' : bySku ? 'sku' : 'word', words: hitWords.get(id) || [] }
}
