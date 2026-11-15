import { normalizeText, quantityFitsUnit } from './grounding'
import { COST_VISIBLE_ROLES, PRICE_TOLERANCE, type ValidationCatalog } from './validateDraft'
import type { DraftDecision, DraftItem, PriceAlert, Product, Reservation, ReviewReason, SaleConsolidated, ValidationContext } from '../contracts'

const round = (value: number, places = 4) => Number(value.toFixed(places))
const money = (value: number) => `S/ ${value.toFixed(2)}`
const EPSILON = 0.000001
const MAX_QTY = 1000000

/** Is `phrase` (normalized: accents, case, punctuation, spaces) a literal fragment of the dictation? */
export const phraseInDictation = (dictation: string, phrase: string) => {
  const needle = normalizeText(phrase).trim()
  return Boolean(needle) && normalizeText(dictation).includes(` ${needle} `)
}

/**
 * STEP 3 — simplified registrar (POS_AGENT_SELECTOR=llm). The selector agent (step 2) already
 * understood the order; this only checks what is needed to register it, with facts from the POS:
 *   1. product_id exists and is active; the presentation (unit) is valid for it (it can be priced);
 *   2. quantity > 0, whole in presentations sold by unit (a dozen allows 0.5); none given → 1;
 *   3. OFFICIAL price (resolve_sale_item_pricing); price_said ≠ list → price_modified (option A);
 *      official 0 → price_unavailable;
 *   4. available stock (minus reservations) and an active payment method;
 *   5. anti-hallucination guard: each line's phrase (and a non-cash payment's phrase) is in the dictation;
 *   6. confidence «baja», no product_id, or a question → por confirmar with the question and options.
 * Everything OK → DIRECT (create_sale). Otherwise → REVIEW with reservation, as in the legacy path.
 * It does NOT re-interpret the text (no quantity attribution, dozens, negations…): that is step 2.
 */
export const makeConsolidatedRegistrar = (catalog: ValidationCatalog) => async (
  consolidated: SaleConsolidated,
  dictation: string,
  reserved: Map<string, number> = new Map(),
  context: ValidationContext = {}
): Promise<DraftDecision> => {
  const reasons: ReviewReason[] = []
  const notes: string[] = []
  const priceAlerts: PriceAlert[] = []
  const items: DraftItem[] = []
  const unreservable = new Set<DraftItem>()
  const products = new Map<string, Product>()
  const canSeeCost = COST_VISIBLE_ROLES.has(String(context.role || ''))

  /** Options shown to the seller with their names (only real, active products). */
  const optionsFor = async (ids: string[]) => (await Promise.all(ids.map(id => catalog.getProduct(id))))
    .filter((p): p is Product => Boolean(p)).map(p => ({ product_id: p.id, name: p.name }))

  for (const [index, line] of consolidated.lines.entries()) {
    const n = index + 1
    const label = `Artículo ${n} («${line.phrase.slice(0, 80)}»)`

    // 5. Anti-hallucination: the line must come from what the seller said.
    if (!phraseInDictation(dictation, line.phrase)) {
      reasons.push({ code: 'phrase_not_in_order', line: n, message: `${label}: esa frase no aparece en el pedido del vendedor.`, detail: { phrase: line.phrase, ungrounded: true } })
      continue
    }

    // 6. The selector is not sure, or asks something: the seller answers (with options).
    const doubtful = line.confidence === 'baja' || !line.product_id || Boolean(line.question)
    if (doubtful) {
      reasons.push({
        code: 'selector_question', line: n,
        message: `${label}: ${line.question || (line.product_id ? 'confirma el producto.' : 'indica el producto.')}`,
        detail: { question: line.question, options: await optionsFor(line.options), confidence: line.confidence, reason: line.reason }
      })
      if (!line.product_id) continue
    }

    // 1. Product exists and is active.
    const product = products.get(line.product_id!) || await catalog.getProduct(line.product_id!)
    if (!product) {
      reasons.push({ code: 'product_inactive', line: n, message: `${label}: el producto no existe o está inactivo.`, detail: { product_id: line.product_id } })
      continue
    }
    products.set(product.id, product)

    // 2. Quantity (rule: none said → 1).
    const quantity = line.quantity ?? 1
    if (line.quantity === null) notes.push(`${product.name}: no se indicó cantidad, se toma 1.`)
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > MAX_QTY) {
      reasons.push({ code: 'missing_quantity', line: n, message: `${label}: la cantidad ${quantity} no es válida.`, detail: { quantity } })
      continue
    }

    // 1. Presentation valid for the product = it can be priced in that unit.
    let quote: Awaited<ReturnType<ValidationCatalog['quote']>>
    try {
      quote = await catalog.quote(product, quantity, line.unit, null)
      if (!Number.isFinite(quote.price) || quote.price < 0 || !Number.isFinite(quote.factor) || quote.factor <= 0 || quote.currency !== 'PEN') {
        throw new Error('Cotización inválida')
      }
    } catch {
      reasons.push({ code: 'unit_unclear', line: n, message: `${label}: la presentación «${line.unit || product.unit}» no es válida para ${product.name}.`, detail: { unit: line.unit } })
      continue
    }
    if (!quantityFitsUnit(quantity, quote.unit_name)) {
      reasons.push({ code: 'missing_quantity', line: n, message: `${label}: la cantidad ${quantity} no es válida para la presentación «${quote.unit_name}».`, detail: { quantity, unit: quote.unit_name } })
      continue
    }

    // 3. Official price; a dictated different price stays por confirmar (option A).
    const official = round(quote.price)
    if (official <= 0) {
      reasons.push({ code: 'price_unavailable', line: n, message: `${label}: ${product.name} tiene precio S/ 0.00 en el catálogo; confirma el precio.`, detail: { list_price: official } })
    }
    let sold = official
    if (line.price_said !== null && Math.abs(line.price_said - official) > PRICE_TOLERANCE) {
      sold = round(line.price_said)
      reasons.push({
        code: 'price_modified', line: n,
        message: `${label}: precio dictado ${money(sold)} distinto al de lista ${money(official)}: queda por confirmar; el revisor la aprueba.`,
        detail: { price_said: sold, list_price: official }
      })
    }
    const item: DraftItem = {
      product_id: product.id, name: product.name, qty: quantity, unit_name: quote.unit_name,
      price_unit: sold, factor: quote.factor, total: round(quantity * sold),
      ...(line.quantity === null ? { quantity_defaulted: true } : {}),
      ...(sold !== official ? { list_price: official, manual_reason: `Precio dictado por vendedor (lista ${money(official)})` } : {})
    }
    const unitCost = Number.isFinite(product.avg_cost) && (product.avg_cost as number) > 0 ? round((product.avg_cost as number) * quote.factor) : null
    if (sold !== official && unitCost !== null && sold < unitCost - PRICE_TOLERANCE) {
      priceAlerts.push({ product_id: product.id, name: product.name, price_unit: sold, ...(canSeeCost ? { unit_cost: unitCost } : {}), level: 'below_cost' })
    }
    items.push(item)
    // A product the selector was not sure about is checked but not reserved (nobody chose it).
    if (doubtful) unreservable.add(item)
  }

  // 4. Stock (repeated lines aggregated in base units) minus other pending sales' reservations.
  const needed = new Map<string, number>()
  const reservable = new Map<string, number>()
  for (const item of items) {
    needed.set(item.product_id, (needed.get(item.product_id) || 0) + item.qty * item.factor)
    if (!unreservable.has(item)) reservable.set(item.product_id, (reservable.get(item.product_id) || 0) + item.qty * item.factor)
  }
  const reservations: Reservation[] = []
  for (const [id, qty] of needed) {
    const product = products.get(id)!
    const held = reserved.get(id) || 0
    const available = Number.isFinite(product.stock) ? round(product.stock - held) : 0
    if (qty > available + EPSILON) {
      reasons.push({
        code: 'insufficient_stock',
        message: `Stock insuficiente de ${product.name}: hay ${Math.max(available, 0)} ${product.unit} disponibles${held ? ` (${round(held)} reservadas en ventas por confirmar)` : ''} y el pedido necesita ${round(qty)}.`,
        detail: { product_id: id, requested: round(qty), available, reserved_by_others: round(held) }
      })
    }
    const hold = round(Math.min(reservable.get(id) || 0, Math.max(available, 0)))
    if (hold > 0) reservations.push({ product_id: id, qty: hold })
  }

  // 4. Payment: an active method. Efectivo when none was said; any other must have been said.
  const methods = await catalog.paymentMethods()
  const wanted = normalizeText(consolidated.payment_method || 'efectivo').trim()
  const method = methods.find(m => normalizeText(m.code).trim() === wanted) || methods.find(m => normalizeText(m.label).trim() === wanted)
  let paymentCode = ''
  let paymentDefaulted = false
  if (!method) {
    reasons.push({ code: 'invalid_payment', message: `La forma de pago «${consolidated.payment_method}» no está disponible en el POS.`, detail: { payment_method: consolidated.payment_method } })
  } else if (normalizeText(method.code).trim() !== 'efectivo' && !(consolidated.payment_phrase && phraseInDictation(dictation, consolidated.payment_phrase))) {
    // Owner's rule: never register Yape / transfer unless the seller said it.
    reasons.push({ code: 'missing_payment', message: `La forma de pago «${method.label}» no aparece en el pedido del vendedor.`, detail: { payment_method: method.code, ungrounded: true } })
  } else {
    paymentCode = method.code
    if (normalizeText(method.code).trim() === 'efectivo' && !consolidated.payment_phrase) {
      paymentDefaulted = true
      notes.push(`Pago: ${method.label.toLowerCase()} (por defecto).`)
    }
  }

  // 6. Questions for the whole order.
  for (const question of consolidated.questions) reasons.push({ code: 'selector_question', message: question, detail: { question, options: [] } })

  if (reasons.length) return { kind: 'review', reasons, items, reservations, notes, price_alerts: priceAlerts, payment_defaulted: paymentDefaulted }
  return {
    kind: 'direct', items, notes, price_alerts: priceAlerts, payment_defaulted: paymentDefaulted,
    sale: { customer_id: null, payment_method: paymentCode, items, currency: 'PEN', total: round(items.reduce((sum, item) => sum + item.total, 0), 2) }
  }
}
