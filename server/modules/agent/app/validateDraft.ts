import { analyzeOrder, choosePayment, decideQuantity, priceGroundedFor, quantityFitsUnit, unitGrounded } from './grounding'
import type { DraftDecision, DraftItem, PriceAlert, Product, Reservation, ReviewReason, SaleDraftV1, ValidationContext } from '../contracts'

/** Read-only catalog used by process 2. Every value comes from the POS, never from the draft. */
export interface ValidationCatalog {
  /** Active product or null (missing/inactive). `stock` = stock_on_hand. */
  getProduct(id: string): Promise<Product | null>
  paymentMethods(): Promise<Array<{ code: string; label: string }>>
  customerExists(id: string): Promise<boolean>
  /** Official price via resolve_sale_item_pricing. */
  quote(product: Product, qty: number, unit: string | null, customerId: string | null): Promise<{
    unit_name: string; price: number; factor: number; currency: string
  }>
}

const normalize = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase()
const round = (value: number, places = 4) => Number(value.toFixed(places))
/** Ends a sentence with one period (notes from agent 1 may already end with punctuation). */
const sentence = (text: string) => /[.!?…]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`
/** A line with these doubts has no product chosen by anyone: its proposed product is NOT reserved. */
const NO_RESERVATION_DOUBTS = new Set(['ambiguous_product', 'product_not_found'])
export const PRICE_TOLERANCE = 0.005
const EPSILON = 0.000001
const MAX_QTY = 1000000
/** Roles that may SEE product costs (below-cost alerts show the cost only to them). */
export const COST_VISIBLE_ROLES = new Set(['owner', 'manager'])
const money = (value: number) => `S/ ${value.toFixed(2)}`

const doubtText: Record<string, string> = {
  ambiguous_product: 'el producto es ambiguo',
  product_not_found: 'no se encontró el producto',
  missing_quantity: 'falta la cantidad',
  unit_unclear: 'la presentación no es clara',
  missing_payment: 'falta la forma de pago',
  customer_ambiguous: 'el cliente es ambiguo',
  other: 'duda del agente'
}

/**
 * PROCESS 2 — deterministic, no AI. Re-verifies a sale-draft/1 against the POS and applies
 * the fixed decision rule:
 *
 *   DIRECT  ⇔ at least one line, and for EVERY line: product_id given, active, confidence "high",
 *             no doubts, valid quantity, official price resolved and equal to the draft price
 *             (when the draft had one) unless the SELLER dictated a price (then: grounded in the text and
 *             it equals the list price; a different one sends the sale to REVIEW with price_modified,
 *             for every role — a reviewer approves it at that price). The quantity
 *             is the one the seller wrote FOR THAT LINE, or 1 when none was said (decideQuantity); the
 *             presentation (unit) must have been said too. A payment method that the SELLER wrote
 *             (draft.source_text, see grounding.ts), enough available stock (stock_on_hand − reservations of
 *             other pending sales); plus a valid payment method, a valid customer (or none) and
 *             no general doubts.
 *   REVIEW  ⇔ anything else. Each failed check adds one coded reason. Stock is reserved for
 *             resolved lines: min(requested, available) per product. A line whose product was only
 *             proposed (doubt ambiguous_product / product_not_found) is checked but NOT reserved.
 *
 * `reserved` = base units already held by OTHER pending sales (never including this one).
 */
export const makeDraftValidator = (catalog: ValidationCatalog) => async (
  draft: SaleDraftV1,
  reserved: Map<string, number> = new Map(),
  context: ValidationContext = {}
): Promise<DraftDecision> => {
  const reasons: ReviewReason[] = []
  const notes: string[] = []
  const priceAlerts: PriceAlert[] = []
  const canSeeCost = COST_VISIBLE_ROLES.has(String(context.role || ''))
  const items: DraftItem[] = []
  /** Items whose product was only proposed (ambiguous / not found): checked, but never reserved. */
  const unreservable = new Set<DraftItem>()
  const products = new Map<string, Product>()

  if (!draft.items.length) {
    reasons.push({ code: 'invalid_draft', message: 'El pedido no tiene artículos identificables.' })
  }
  for (const doubt of draft.doubts) {
    // The payment is decided here from the seller's text (efectivo by default): agent 1's
    // «falta la forma de pago» is not a reason to review.
    if (doubt.code === 'missing_payment') continue
    reasons.push({ code: 'agent_doubt', message: sentence(`Duda del pedido: ${doubt.note || doubtText[doubt.code]}`), detail: { doubt: doubt.code } })
  }

  // Payment: efectivo by default; another method only if the SELLER said it (the AI's proposal does
  // not count by itself). A method said that the POS does not have, or several, go to review.
  let paymentCode = ''
  let paymentDefaulted = false
  const choice = choosePayment(draft.source_text, await catalog.paymentMethods())
  if (choice.kind === 'said') paymentCode = choice.method.code
  else if (choice.kind === 'default') {
    paymentCode = choice.method.code
    paymentDefaulted = true
    notes.push(`Pago: ${choice.method.label.toLowerCase()} (por defecto).`)
  } else if (choice.kind === 'ambiguous') {
    reasons.push({ code: 'missing_payment', message: `Se mencionan varias formas de pago (${choice.methods.map(m => m.label).join(', ')}); indica una.`, detail: { methods: choice.methods.map(m => m.code) } })
  } else if (choice.kind === 'unavailable') {
    reasons.push({ code: 'invalid_payment', message: `La forma de pago «${choice.said}» no está disponible en el POS.`, detail: { payment_method: choice.said } })
  } else {
    reasons.push({ code: 'missing_payment', message: 'No hay forma de pago «efectivo» activa en el POS para usarla por defecto.' })
  }
  let customerId: string | null = null
  if (draft.customer_id) {
    if (await catalog.customerExists(draft.customer_id)) customerId = draft.customer_id
    else reasons.push({ code: 'invalid_customer', message: 'El cliente indicado no existe en el POS.', detail: { customer_id: draft.customer_id } })
  }

  // Which quantities and amounts the seller wrote for each line (by position in the text).
  const evidence = analyzeOrder(draft.source_text, draft.items)
  for (const [index, line] of draft.items.entries()) {
    const n = index + 1
    const label = `Artículo ${n}${line.query ? ` («${line.query.slice(0, 80)}»)` : ''}`
    for (const doubt of line.doubts) {
      reasons.push({ code: 'agent_doubt', line: n, message: sentence(`${label}: ${doubt.note || doubtText[doubt.code]}`), detail: { doubt: doubt.code } })
    }
    if (line.confidence !== 'high') {
      reasons.push({ code: 'low_confidence', line: n, message: `${label}: identificación con seguridad ${line.confidence === 'medium' ? 'media' : 'baja'}.`, detail: { confidence: line.confidence } })
    }

    let product: Product | null = null
    if (!line.product_id) {
      reasons.push({ code: 'product_unresolved', line: n, message: `${label}: falta elegir el producto${line.candidates.length ? ` entre ${line.candidates.length} opciones` : ''}.`, detail: { candidates: line.candidates } })
    } else {
      product = products.get(line.product_id) || await catalog.getProduct(line.product_id)
      if (!product) reasons.push({ code: 'product_inactive', line: n, message: `${label}: el producto no existe o está inactivo.`, detail: { product_id: line.product_id } })
      else products.set(product.id, product)
    }

    if (line.quantity !== null && (!Number.isFinite(line.quantity) || line.quantity <= 0 || line.quantity > MAX_QTY)) {
      reasons.push({ code: 'missing_quantity', line: n, message: `${label}: la cantidad ${line.quantity} no es válida.` })
      continue
    }
    // "Si no se dice cantidad es 1": a quantity the seller wrote is used; otherwise 1.
    const decided = decideQuantity(evidence, index, line)
    if (!decided.ok) {
      reasons.push({
        code: 'missing_quantity', line: n, detail: { quantity: line.quantity, ungrounded: true },
        message: decided.reason === 'unassigned'
          ? `${label}: el pedido menciona una cantidad que no pude asignar a este artículo.`
          : `${label}: la cantidad ${line.quantity} no aparece como cantidad en el pedido del vendedor.`
      })
      // Without any quantity there is nothing to quote; an unverified one is still checked (price, stock).
      if (line.quantity === null) continue
    }
    const quantity = decided.ok ? decided.quantity : line.quantity!
    if (!product) continue
    // The AI may not invent the presentation: «2 lapiceros» is not «2 cajas».
    if (!unitGrounded(draft.source_text, line.unit, product.unit)) {
      reasons.push({ code: 'unit_unclear', line: n, message: `${label}: la presentación «${line.unit}» no aparece en el pedido del vendedor.`, detail: { unit: line.unit, ungrounded: true } })
      continue
    }

    let quote: Awaited<ReturnType<ValidationCatalog['quote']>>
    try {
      quote = await catalog.quote(product, quantity, line.unit, customerId)
      if (!Number.isFinite(quote.price) || quote.price < 0 || !Number.isFinite(quote.factor) || quote.factor <= 0 || quote.currency !== 'PEN') {
        throw new Error('Cotización inválida')
      }
    } catch {
      reasons.push({ code: 'price_unavailable', line: n, message: `${label}: no hay precio para la presentación «${line.unit || product.unit}» de ${product.name}.`, detail: { unit: line.unit } })
      continue
    }
    if (!quantityFitsUnit(quantity, quote.unit_name)) {
      reasons.push({ code: 'missing_quantity', line: n, message: `${label}: la cantidad ${quantity} no es válida para la presentación «${quote.unit_name}».`, detail: { quantity, unit: quote.unit_name } })
      continue
    }
    const official = round(quote.price)
    if (official <= 0) {
      // A zero list price is a catalog gap: never sold directly (process 2 checks it, whatever agent 1 said).
      reasons.push({ code: 'price_unavailable', line: n, message: `${label}: ${product.name} tiene precio S/ 0.00 en el catálogo; confirma el precio.`, detail: { list_price: official } })
    }
    let sold = official
    const dictated = line.price_said !== null && Math.abs(line.price_said - official) > PRICE_TOLERANCE ? round(line.price_said) : null
    if (dictated !== null) {
      // A dictated price is the sale the seller is making, but only if the SELLER wrote it.
      if (!priceGroundedFor(evidence, index, dictated, quantity)) {
        reasons.push({ code: 'price_unverified', line: n, message: `${label}: el precio ${money(dictated)} no aparece en el pedido del vendedor (lista ${money(official)}).`, detail: { price_said: dictated, list_price: official, ungrounded: true } })
      } else {
        // Business rule (owner, 2026-11-15, option A): a dictated price different from the list price
        // is NEVER registered directly, for any role. The sale stays "por confirmar" (stock reserved)
        // and a reviewer (owner/manager) approves it at that price. Both prices are kept per line.
        sold = dictated
        reasons.push({
          code: 'price_modified', line: n,
          message: `${label}: precio dictado ${money(dictated)} distinto al de lista ${money(official)}: queda por confirmar; el revisor la aprueba.`,
          detail: { price_said: dictated, list_price: official }
        })
      }
    } else if (line.price_said === null && line.price_unit !== null && Math.abs(line.price_unit - official) > PRICE_TOLERANCE) {
      // Not dictated: the price agent 1 saw differs from the official one.
      reasons.push({
        code: 'price_changed', line: n,
        message: `${label}: el precio de ${product.name} es ${money(official)} y no ${money(line.price_unit)}.`,
        detail: { draft_price: line.price_unit, official_price: official }
      })
    }
    const item: DraftItem = {
      product_id: product.id, name: product.name, qty: quantity, unit_name: quote.unit_name,
      price_unit: sold, factor: quote.factor, total: round(quantity * sold),
      ...(decided.ok && decided.defaulted ? { quantity_defaulted: true } : {}),
      ...(sold !== official ? { list_price: official, manual_reason: `Precio dictado por vendedor (lista ${money(official)})` } : {})
    }
    if (decided.ok && decided.defaulted) notes.push(`${product.name}: no se indicó cantidad, se toma 1 ${quote.unit_name}.`)
    // Below cost: never blocks, it is reported. Cost of the sold presentation = avg cost × factor.
    const unitCost = Number.isFinite(product.avg_cost) && (product.avg_cost as number) > 0 ? round((product.avg_cost as number) * quote.factor) : null
    if (sold !== official && unitCost !== null && sold < unitCost - PRICE_TOLERANCE) {
      // The cost is shown only to owner/manager; other sellers just get «precio bajo».
      priceAlerts.push({ product_id: product.id, name: product.name, price_unit: sold, ...(canSeeCost ? { unit_cost: unitCost } : {}), level: 'below_cost' })
    }
    items.push(item)
    if (line.doubts.some(doubt => NO_RESERVATION_DOUBTS.has(doubt.code))) unreservable.add(item)
  }

  // Stock: aggregate repeated lines in base units before comparing.
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

  if (reasons.length) return { kind: 'review', reasons, items, reservations, notes, price_alerts: priceAlerts, payment_defaulted: paymentDefaulted }
  return {
    kind: 'direct', items, notes, price_alerts: priceAlerts, payment_defaulted: paymentDefaulted,
    sale: {
      customer_id: customerId, payment_method: paymentCode, items, currency: 'PEN',
      total: round(items.reduce((sum, item) => sum + item.total, 0), 2)
    }
  }
}
