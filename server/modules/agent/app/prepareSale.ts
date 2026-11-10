import type { Interpretation, Product, SaleDraft } from '../contracts'

export interface AgentCatalog {
  findProducts(query: string, sku?: string | null): Promise<Product[]>
  getProduct(id: string): Promise<Product | null>
  findCustomers(query: string): Promise<Array<{ id: string; name: string }>>
  paymentMethods(): Promise<Array<{ code: string; label: string }>>
  quote(product: Product, qty: number, unit: string | null, customerId: string | null): Promise<{
    unit_name: string; price: number; factor: number; currency: string
  }>
}
const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase()
const round = (value: number, places: number) => Number(value.toFixed(places))

export const makeSalePreparer = (catalog: AgentCatalog) => async (input: Interpretation, previousCandidates: Product[]) => {
  const candidates: Product[] = []
  const questions: string[] = input.question?.trim() ? [input.question.trim().slice(0, 500)] : []
  const draft: SaleDraft = { customer_id: null, payment_method: '', items: [], total: 0, currency: 'PEN' }
  if (!input.items.length || input.items.length > 20) {
    return { candidates, question: 'Indica entre 1 y 20 artículos, con su cantidad, presentación y forma de pago.' }
  }
  if (input.customer_query) {
    const customers = await catalog.findCustomers(input.customer_query)
    if (customers.length !== 1) questions.push(customers.length ? `Especifica el cliente: ${customers.map(c => c.name).join('; ')}.` : 'No encontré ese cliente. Indica su nombre completo o pide una venta al público.')
    else draft.customer_id = customers[0].id
  }
  const methods = await catalog.paymentMethods()
  const payment = methods.find(p => input.payment_method && [p.code, p.label].some(value => normalize(value) === normalize(input.payment_method!)))
  if (!payment) questions.push(`Indica una forma de pago disponible: ${methods.map(p => p.label).join(', ')}.`)
  else draft.payment_method = payment.code

  for (const [index, item] of input.items.entries()) {
    const label = `Artículo ${index + 1}`
    let product: Product | null = null
    if (item.product_id) {
      // An LLM-provided ID is valid only when it came from a previous real candidate.
      if (previousCandidates.some(p => p.id === item.product_id)) product = await catalog.getProduct(item.product_id)
      if (!product) questions.push(`${label}: la selección no corresponde a una opción disponible. Indica nuevamente el producto.`)
    } else {
      const matches = await catalog.findProducts(item.query, item.sku)
      if (matches.length === 1) product = matches[0]
      else if (!matches.length) questions.push(`${label}: no encontré «${item.query}». Especifica producto, marca o SKU.`)
      else {
        const start = candidates.length
        candidates.push(...matches)
        questions.push(`${label}: elige el producto por nombre o SKU: ${matches.map((p, i) => `${start + i + 1}) ${p.name}${p.brand ? ` / ${p.brand}` : ''} [${p.sku}]`).join('; ')}. Si no aparece el correcto, precisa la búsqueda.`)
      }
    }
    if (product && !candidates.some(p => p.id === product!.id)) candidates.push(product)
    if (item.quantity === null || !Number.isFinite(item.quantity) || item.quantity <= 0 || item.quantity > 1000000) {
      questions.push(`${label}: ¿cuántas unidades o presentaciones deseas vender? Separa la cantidad del número de hojas u otros atributos.`)
      continue
    }
    if (!product) continue
    try {
      const quote = await catalog.quote(product, item.quantity, item.unit, draft.customer_id)
      if (!Number.isFinite(quote.price) || quote.price < 0 || !Number.isFinite(quote.factor) || quote.factor <= 0 || quote.currency !== 'PEN') throw new Error('Cotización inválida')
      draft.items.push({ product_id: product.id, name: product.name, qty: item.quantity, unit_name: quote.unit_name, price_unit: quote.price, factor: quote.factor, total: round(item.quantity * quote.price, 4) })
    } catch {
      questions.push(`${label}: no pude cotizar la presentación solicitada para ${product.name}. Indica una presentación válida.`)
    }
  }
  const quantities = new Map<string, number>()
  for (const item of draft.items) quantities.set(item.product_id, (quantities.get(item.product_id) || 0) + item.qty * item.factor)
  for (const [id, qty] of quantities) {
    const product = candidates.find(p => p.id === id)!
    if (!Number.isFinite(product.stock) || qty > product.stock + 0.000001) questions.push(`Stock insuficiente de ${product.name}: hay ${product.stock} ${product.unit}, y el pedido necesita ${round(qty, 4)}.`)
  }
  if (questions.length) return { candidates, question: questions.join('\n') }
  draft.total = round(draft.items.reduce((sum, item) => sum + item.total, 0), 2)
  return { candidates, draft }
}
