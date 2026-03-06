#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const INPUT_PATH = path.resolve(process.cwd(), 'supabase', 'products_without_category_after_apply.csv')
const CATEGORIES_PATH = path.resolve(process.cwd(), 'supabase', 'categories_after_normalization.csv')
const OUTPUT_CSV = path.resolve(process.cwd(), 'supabase', 'category_suggestions_for_112_products.csv')
const OUTPUT_JSON = path.resolve(process.cwd(), 'supabase', 'category_suggestions_for_112_products_summary.json')

function readCsv(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8')
  const lines = raw.split(/\r?\n/).filter(Boolean)
  if (!lines.length) return []
  const headers = splitCsvLine(lines[0])
  return lines.slice(1).map((line) => {
    const cols = splitCsvLine(line)
    const row = {}
    headers.forEach((header, idx) => {
      row[header] = cols[idx] ?? ''
    })
    return row
  })
}

function splitCsvLine(line) {
  const out = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"'
        i += 1
      } else {
        inQuotes = !inQuotes
      }
      continue
    }
    if (ch === ',' && !inQuotes) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  out.push(cur)
  return out
}

function toCsv(rows, headers) {
  const escape = (value) => {
    const str = String(value ?? '')
    if (str.includes('"') || str.includes(',') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`
    }
    return str
  }
  const lines = [headers.join(',')]
  for (const row of rows) {
    lines.push(headers.map((h) => escape(row[h])).join(','))
  }
  return `${lines.join('\n')}\n`
}

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function includesAny(text, patterns) {
  return patterns.some((p) => text.includes(p))
}

const CONF_SCORE = { alta: 3, media: 2, baja: 1 }

function suggestFor(nameRaw) {
  const n = normalize(nameRaw)

  if (includesAny(n, ['taps', 'tiros', 'cholito'])) {
    return { category: '', action: 'revisar_manual', confidence: 'baja', reason: 'descripcion_ambigua' }
  }

  if (n.includes('cuadernillo')) {
    return { category: 'Cuaderno', action: 'asignar_existente', confidence: 'alta', reason: 'keyword_cuadernillo' }
  }
  if (includesAny(n, ['tarjador', 'tajador'])) {
    return { category: 'Sacapunta', action: 'asignar_existente', confidence: 'alta', reason: 'keyword_tarjador' }
  }
  if (n.includes('escuadra')) {
    return { category: 'Regla', action: 'asignar_existente', confidence: 'media', reason: 'escuadra_es_util_de_medicion' }
  }
  if (n.includes('gancho')) {
    return { category: 'Gancho', action: 'asignar_existente', confidence: 'alta', reason: 'keyword_gancho' }
  }
  if (n.includes('sobre manila')) {
    return { category: 'Papel', action: 'asignar_existente', confidence: 'alta', reason: 'keyword_sobre_manila' }
  }
  if (includesAny(n, ['microporoso'])) {
    return { category: 'Microporoso', action: 'crear_nueva', confidence: 'alta', reason: 'familia_microporoso' }
  }
  if (includesAny(n, [' mica ', ' micas', 'micas ']) || n.startsWith('micas')) {
    return { category: 'Mica', action: 'crear_nueva', confidence: 'alta', reason: 'familia_micas' }
  }
  if (includesAny(n, ['papel', 'cartulina', 'hojas de color', 'sedita', 'silufan'])) {
    return { category: 'Papel', action: 'asignar_existente', confidence: 'media', reason: 'familia_papel_cartulina' }
  }

  if (includesAny(n, ['cometa', 'trompo', 'ula ula', 'dados', 'silvato', 'trish', 'pelotas de trapo'])) {
    return { category: 'Juguetes', action: 'asignar_existente', confidence: 'media', reason: 'producto_ludico' }
  }
  if (n.includes('llavero')) {
    return { category: 'Llavero', action: 'crear_nueva', confidence: 'alta', reason: 'familia_llaveros' }
  }
  if (includesAny(n, ['tomatodo'])) {
    return { category: 'Tomatodo', action: 'asignar_existente', confidence: 'alta', reason: 'keyword_tomatodo' }
  }
  if (includesAny(n, ['lonchera', 'loncheras'])) {
    return { category: 'Lonchera', action: 'crear_nueva', confidence: 'media', reason: 'familia_loncheras' }
  }

  if (includesAny(n, ['escobilla', 'esponja', 'perchero', 'vaso de plastico'])) {
    return { category: 'Limpieza Hogar', action: 'crear_nueva', confidence: 'media', reason: 'hogar_limpieza' }
  }
  if (includesAny(n, ['jabon', 'pasta dental', 'cepillo', 'hizopo', 'cortau', 'jabonera', 'guantes', 'guillet'])) {
    return { category: 'Aseo Personal', action: 'crear_nueva', confidence: 'media', reason: 'higiene_personal' }
  }

  if (includesAny(n, ['alfiler', 'chinche', 'clip', 'fastener', 'imperdible', 'pinza'])) {
    return { category: 'Sujetadores', action: 'crear_nueva', confidence: 'alta', reason: 'familia_sujecion' }
  }

  if (includesAny(n, ['adorno', 'bandera', 'globos', 'serpentina', 'mistura', 'rosa', 'corazon de regalos', 'luces', 'escarapela', 'perlas adornos'])) {
    return { category: 'Fiestas y Decoracion', action: 'crear_nueva', confidence: 'media', reason: 'fiesta_decoracion' }
  }

  if (includesAny(n, ['baja lengua', 'brocheta', 'crepe', 'escarcha', 'lentejuela', 'ojitos', 'pompon', 'tira fomy', 'tira ojos', 'tira perlas', 'tira rosa', 'carton cartulina'])) {
    return { category: 'Manualidades', action: 'crear_nueva', confidence: 'alta', reason: 'insumo_manualidades' }
  }

  if (includesAny(n, ['colet', 'monera', 'pirana', 'vincha', 'liga para cabello', 'cordones', 'pulsera', 'pares de pilis'])) {
    return { category: 'Accesorios de Cabello', action: 'crear_nueva', confidence: 'media', reason: 'accesorios_cabello' }
  }
  if (includesAny(n, ['liga de lana', 'lana de colores'])) {
    return { category: 'Manualidades', action: 'crear_nueva', confidence: 'media', reason: 'insumo_lana_manualidades' }
  }

  if (includesAny(n, ['llajes', 'pelotitas de llajes'])) {
    return { category: 'Merceria', action: 'crear_nueva', confidence: 'baja', reason: 'termino_local_no_estandar' }
  }

  if (includesAny(n, ['tabla periodica', 'tableros acrilicos', 'meseros personales', 'puntero'])) {
    return { category: 'Material Educativo', action: 'crear_nueva', confidence: 'media', reason: 'material_escolar_educativo' }
  }

  if (n.includes('pozzis') || n.includes('limpiatipo')) {
    return { category: 'Goma', action: 'asignar_existente', confidence: 'media', reason: 'adhesivo_reutilizable' }
  }

  if (n.includes('batisoga')) {
    return { category: 'Textil Escolar', action: 'crear_nueva', confidence: 'baja', reason: 'familia_batisoga' }
  }

  if (n.includes('pines') || n.includes('pines de decoracion') || n.includes('pines de decoracion')) {
    return { category: 'Fiestas y Decoracion', action: 'crear_nueva', confidence: 'media', reason: 'pines_decorativos' }
  }

  if (n.includes('tasa con rosas')) {
    return { category: 'Fiestas y Decoracion', action: 'crear_nueva', confidence: 'media', reason: 'regalo_decorativo' }
  }

  return { category: '', action: 'revisar_manual', confidence: 'baja', reason: 'sin_regla' }
}

function main() {
  const products = readCsv(INPUT_PATH)
  const categories = readCsv(CATEGORIES_PATH)
  const existing = new Set(categories.filter((c) => String(c.active).toLowerCase() === 'true').map((c) => c.name))

  const rows = products.map((p) => {
    const suggestion = suggestFor(p.name)
    let action = suggestion.action
    if (suggestion.category && existing.has(suggestion.category) && action === 'crear_nueva') {
      action = 'asignar_existente'
    }
    return {
      product_id: p.product_id,
      sku: p.sku,
      name: p.name,
      brand: p.brand,
      current_product_type: p.product_type,
      suggested_category: suggestion.category,
      suggested_action: action,
      confidence: suggestion.confidence,
      confidence_score: CONF_SCORE[suggestion.confidence] || 0,
      reason: suggestion.reason
    }
  })

  const byCategory = new Map()
  const byAction = new Map()
  const byConfidence = new Map()
  for (const r of rows) {
    const cat = r.suggested_category || '(sin sugerencia)'
    byCategory.set(cat, (byCategory.get(cat) || 0) + 1)
    byAction.set(r.suggested_action, (byAction.get(r.suggested_action) || 0) + 1)
    byConfidence.set(r.confidence, (byConfidence.get(r.confidence) || 0) + 1)
  }

  const summary = {
    total_products: rows.length,
    by_action: Object.fromEntries([...byAction.entries()].sort((a, b) => b[1] - a[1])),
    by_confidence: Object.fromEntries([...byConfidence.entries()].sort((a, b) => b[1] - a[1])),
    by_category: [...byCategory.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([category, count]) => ({ category, count }))
  }

  fs.writeFileSync(
    OUTPUT_CSV,
    toCsv(rows, [
      'product_id',
      'sku',
      'name',
      'brand',
      'current_product_type',
      'suggested_category',
      'suggested_action',
      'confidence',
      'confidence_score',
      'reason'
    ]),
    'utf8'
  )
  fs.writeFileSync(OUTPUT_JSON, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')

  console.log(JSON.stringify(summary, null, 2))
  console.error(`Wrote ${OUTPUT_CSV}`)
  console.error(`Wrote ${OUTPUT_JSON}`)
}

main()
