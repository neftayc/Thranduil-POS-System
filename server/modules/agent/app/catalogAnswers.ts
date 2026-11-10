import type { Interpretation, Product } from '../contracts'
import { makeProductMatcher, matchQuery, type AgentCatalog } from './prepareSale'
import { closestCandidates } from './productSearch'

const money = (value: number) => `S/ ${value.toFixed(2)}`

/**
 * Answers catalog questions ("¿tenemos cuadernos Marking cuadriculados?", "¿cuánto cuesta?",
 * "¿cuántos quedan?") with real data only: products from the catalog, price from
 * resolve_sale_item_pricing and live stock. Nothing is invented; unknown values are said so.
 * Sales reports with calculations are out of scope (they come from predefined queries).
 */
export const makeCatalogAnswerer = (catalog: AgentCatalog) => {
  const match = makeProductMatcher(catalog)
  return async (input: Interpretation) => {
    const lines: string[] = []
    const answers: Array<Record<string, unknown>> = []
    if (!input.items.length) {
      return { message: 'Indica qué producto quieres consultar (nombre, marca o características).', result: { answers } }
    }
    for (const item of input.items.slice(0, 10)) {
      const query = matchQuery(item)
      const { decision, products } = await match(query)
      const compatible = decision.ranked.filter(c => !c.conflicts.length && (c.coverage >= 0.6 || c.learned) && products.has(c.doc.id)).slice(0, 5)
      if (!compatible.length) {
        const closest = closestCandidates(decision.ranked).find(c => products.has(c.doc.id))
        lines.push(`No encontré «${item.query}» en el catálogo.${closest ? ` Lo más parecido: ${closest.doc.name}${closest.conflicts.length ? ` (${closest.conflicts.join('; ')})` : ''}.` : ''}`)
        answers.push({ query: item.query, found: false, closest: closest ? { product_id: closest.doc.id, name: closest.doc.name } : null })
        continue
      }
      const found: Array<Record<string, unknown>> = []
      const parts: string[] = []
      for (const candidate of compatible) {
        const product = products.get(candidate.doc.id) as Product
        let price: { unit_name: string; price: number } | null = null
        try {
          const quote = await catalog.quote(product, 1, item.unit, null)
          if (Number.isFinite(quote.price) && quote.price >= 0 && quote.currency === 'PEN') price = quote.price > 0 ? { unit_name: quote.unit_name, price: quote.price } : null
        } catch { /* price unknown: say so, never guess */ }
        const stock = Number.isFinite(product.stock) ? product.stock : null
        parts.push(`${product.name}${product.brand ? ` (${product.brand})` : ''}: ${price ? `${money(price.price)} por ${price.unit_name}` : 'precio no disponible'}, ${stock === null ? 'stock no disponible' : stock > 0 ? `quedan ${stock} ${product.unit}` : 'agotado'}`)
        found.push({ product_id: product.id, name: product.name, sku: product.sku, brand: product.brand, unit: product.unit, stock, price: price?.price ?? null, price_unit: price?.unit_name ?? null, exact: decision.best?.doc.id === product.id && decision.confidence === 'high' })
      }
      const head = decision.confidence === 'high' ? 'Sí, tenemos' : `Para «${item.query}» encontré`
      lines.push(`${head}: ${parts.join('; ')}.`)
      answers.push({ query: item.query, found: true, products: found })
    }
    return { message: lines.join('\n'), result: { answers } }
  }
}
