import { paymentMentioned, quantityGrounded } from './grounding'
import type { DraftDecision, DraftItem, Product, Reservation, ReviewReason, SaleDraftV1 } from '../contracts'

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
export const PRICE_TOLERANCE = 0.005
const EPSILON = 0.000001
const MAX_QTY = 1000000

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
 *             (when the draft had one), a quantity and a payment method that the SELLER wrote
 *             (draft.source_text, see grounding.ts), enough available stock (stock_on_hand − reservations of
 *             other pending sales); plus a valid payment method, a valid customer (or none) and
 *             no general doubts.
 *   REVIEW  ⇔ anything else. Each failed check adds one coded reason. Stock is reserved for
 *             resolved lines: min(requested, available) per product.
 *
 * `reserved` = base units already held by OTHER pending sales (never including this one).
 */
export const makeDraftValidator = (catalog: ValidationCatalog) => async (
  draft: SaleDraftV1,
  reserved: Map<string, number> = new Map()
): Promise<DraftDecision> => {
  const reasons: ReviewReason[] = []
  const items: DraftItem[] = []
  const products = new Map<string, Product>()

  if (!draft.items.length) {
    reasons.push({ code: 'invalid_draft', message: 'El pedido no tiene artículos identificables.' })
  }
  for (const doubt of draft.doubts) {
    reasons.push({ code: 'agent_doubt', message: `Duda del pedido: ${doubt.note || doubtText[doubt.code]}.`, detail: { doubt: doubt.code } })
  }

  let paymentCode = ''
  if (!draft.payment_method) {
    reasons.push({ code: 'missing_payment', message: 'Falta la forma de pago (no se asume efectivo).' })
  } else {
    const methods = await catalog.paymentMethods()
    const wanted = normalize(draft.payment_method)
    const method = methods.find(m => normalize(m.code) === wanted) || methods.find(m => normalize(m.label) === wanted)
    if (method && !paymentMentioned(draft.source_text, method)) {
      // The AI may not invent the payment method: the seller must have said it.
      reasons.push({ code: 'missing_payment', message: `La forma de pago «${method.label}» no aparece en el pedido del vendedor (no se asume).`, detail: { payment_method: draft.payment_method, ungrounded: true } })
    } else if (method) paymentCode = method.code
    else reasons.push({ code: 'invalid_payment', message: `La forma de pago «${draft.payment_method}» no existe en el POS.`, detail: { payment_method: draft.payment_method } })
  }

  let customerId: string | null = null
  if (draft.customer_id) {
    if (await catalog.customerExists(draft.customer_id)) customerId = draft.customer_id
    else reasons.push({ code: 'invalid_customer', message: 'El cliente indicado no existe en el POS.', detail: { customer_id: draft.customer_id } })
  }

  for (const [index, line] of draft.items.entries()) {
    const n = index + 1
    const label = `Artículo ${n}${line.query ? ` («${line.query.slice(0, 80)}»)` : ''}`
    for (const doubt of line.doubts) {
      reasons.push({ code: 'agent_doubt', line: n, message: `${label}: ${doubt.note || doubtText[doubt.code]}.`, detail: { doubt: doubt.code } })
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

    if (line.quantity === null || !Number.isFinite(line.quantity) || line.quantity <= 0 || line.quantity > MAX_QTY) {
      reasons.push({ code: 'missing_quantity', line: n, message: `${label}: falta una cantidad válida.` })
      continue
    }
    if (!quantityGrounded(draft.source_text, line.quantity, line.query)) {
      // The AI may not invent the quantity nor take it from the description ("100 hojas", "a4").
      reasons.push({ code: 'missing_quantity', line: n, message: `${label}: la cantidad ${line.quantity} no aparece como cantidad en el pedido del vendedor.`, detail: { quantity: line.quantity, ungrounded: true } })
    }
    if (!product) continue

    let quote: Awaited<ReturnType<ValidationCatalog['quote']>>
    try {
      quote = await catalog.quote(product, line.quantity, line.unit, customerId)
      if (!Number.isFinite(quote.price) || quote.price < 0 || !Number.isFinite(quote.factor) || quote.factor <= 0 || quote.currency !== 'PEN') {
        throw new Error('Cotización inválida')
      }
    } catch {
      reasons.push({ code: 'price_unavailable', line: n, message: `${label}: no hay precio para la presentación «${line.unit || product.unit}» de ${product.name}.`, detail: { unit: line.unit } })
      continue
    }
    const official = round(quote.price)
    if (line.price_unit !== null && Math.abs(line.price_unit - official) > PRICE_TOLERANCE) {
      reasons.push({
        code: 'price_changed', line: n,
        message: `${label}: el precio de ${product.name} es S/ ${official.toFixed(2)} y no S/ ${line.price_unit.toFixed(2)}.`,
        detail: { draft_price: line.price_unit, official_price: official }
      })
    }
    items.push({
      product_id: product.id, name: product.name, qty: line.quantity, unit_name: quote.unit_name,
      price_unit: official, factor: quote.factor, total: round(line.quantity * official)
    })
  }

  // Stock: aggregate repeated lines in base units before comparing.
  const needed = new Map<string, number>()
  for (const item of items) needed.set(item.product_id, (needed.get(item.product_id) || 0) + item.qty * item.factor)
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
    const hold = round(Math.min(qty, Math.max(available, 0)))
    if (hold > 0) reservations.push({ product_id: id, qty: hold })
  }

  if (reasons.length) return { kind: 'review', reasons, items, reservations }
  return {
    kind: 'direct', items,
    sale: {
      customer_id: customerId, payment_method: paymentCode, items, currency: 'PEN',
      total: round(items.reduce((sum, item) => sum + item.total, 0), 2)
    }
  }
}
