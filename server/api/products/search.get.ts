import { defineEventHandler, getQuery, createError } from 'h3'
import { getSupabaseAdminClient } from '../../utils/supabase'

/**
 * Búsqueda profesional de productos por tokens.
 * Divide el query en palabras y exige que TODAS aparezcan en el nombre
 * (sin importar el orden). Ejemplo: "cuadernos 100h" → encuentra productos
 * cuyo nombre contenga "cuadernos" Y "100h".
 *
 * Estrategia:
 * 1. Full-text search con tsquery (diccionario 'simple' para no alterar tokens).
 * 2. Si no hay resultados o falla, fallback con múltiples .ilike() en AND.
 */
export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const q = String(query.q || '').trim()

  if (q.length < 2) return []

  const supabase = getSupabaseAdminClient()

  // Tokenizar: separar por espacios y limpiar tokens vacíos
  const tokens = q
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)

  // ── Estrategia 1: full-text search con tsquery ──────────────────────
  // Construye "token1:* & token2:* & ..." para búsqueda de prefijos AND
  const tsQuery = tokens.map((t) => `${t}:*`).join(' & ')

  try {
    const { data: ftData, error: ftError } = await supabase
      .from('products')
      .select('id, sku, name, brand, sale_price, unit, stock_on_hand')
      .textSearch('name', tsQuery, { type: 'websearch', config: 'simple' })
      .order('name')
      .limit(30)

    if (!ftError && ftData && ftData.length > 0) {
      return ftData
    }
  } catch {
    // Si falla el full-text search, continuamos con el fallback
  }

  // ── Estrategia 2: fallback con múltiples ilike en AND ───────────────
  // Cada token debe aparecer en algún lugar del nombre (cualquier orden)
  let dbQuery = supabase
    .from('products')
    .select('id, sku, name, brand, sale_price, unit, stock_on_hand')
    .order('name')
    .limit(30)

  for (const token of tokens) {
    dbQuery = dbQuery.ilike('name', `%${token}%`)
  }

  const { data, error } = await dbQuery

  if (error) throw createError({ statusCode: 500, statusMessage: error.message })
  return data || []
})

