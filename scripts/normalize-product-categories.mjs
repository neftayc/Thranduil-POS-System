#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const APPLY = process.argv.includes('--apply')
const WRITE_REPORT = process.argv.includes('--write-report')
const NEW_CATEGORY_MIN_SIZE = Number(process.env.NEW_CATEGORY_MIN_SIZE || 3)

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return
  const raw = fs.readFileSync(filePath, 'utf8')
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx <= 0) continue
    const key = trimmed.slice(0, idx).trim()
    let value = trimmed.slice(idx + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = value
  }
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const IRREGULAR_SINGULAR = new Map([
  ['lapices', 'lapiz'],
  ['luces', 'luz'],
  ['crayones', 'crayon'],
  ['plumones', 'plumon'],
  ['marcadores', 'marcador'],
  ['cuadernos', 'cuaderno'],
  ['folders', 'folder'],
  ['sobres', 'sobre'],
  ['reglas', 'regla'],
  ['tijeras', 'tijera'],
  ['gomas', 'goma'],
  ['borradores', 'borrador'],
  ['cartulinas', 'cartulina'],
  ['papeles', 'papel'],
  ['temperas', 'tempera'],
  ['acuarelas', 'acuarela'],
  ['plastilinas', 'plastilina'],
  ['pegamentos', 'pegamento'],
  ['cintas', 'cinta'],
  ['pinceles', 'pincel'],
  ['boligrafos', 'boligrafo'],
  ['lapiceros', 'lapicero'],
  ['resaltadores', 'resaltador'],
  ['correctores', 'corrector'],
  ['notas', 'nota'],
  ['etiquetas', 'etiqueta'],
  ['carpetas', 'carpeta'],
  ['archivadores', 'archivador'],
  ['calculadoras', 'calculadora'],
  ['compases', 'compas'],
  ['escuadras', 'escuadra'],
  ['utiles', 'util']
])

const TOKEN_ALIASES = new Map([
  ['corector', 'corrector'],
  ['correctores', 'corrector'],
  ['stiker', 'sticker'],
  ['stikers', 'sticker'],
  ['stickers', 'sticker'],
  ['tajador', 'sacapunta'],
  ['tarjador', 'sacapunta'],
  ['sacapuntas', 'sacapunta'],
  ['llajes', 'llaje']
])

function singularizeToken(token) {
  if (!token) return ''
  if (IRREGULAR_SINGULAR.has(token)) return IRREGULAR_SINGULAR.get(token)
  if (TOKEN_ALIASES.has(token)) return TOKEN_ALIASES.get(token)
  if (token.length <= 3) return token
  if (/ces$/.test(token) && token.length > 4) return `${token.slice(0, -3)}z`
  if (/[bcdfghjklmnñpqrstvwxyz]es$/.test(token) && token.length > 4) return token.slice(0, -2)
  if (/[aeiou]s$/.test(token) && token.length > 4) return token.slice(0, -1)
  return TOKEN_ALIASES.get(token) || token
}

function canonicalCategoryKey(name) {
  const normalized = normalizeText(name)
  if (!normalized) return ''
  const base = normalized
    .split(' ')
    .filter(Boolean)
    .map((token) => singularizeToken(token))
    .join(' ')
  return base
    .replace(/\bsaca punta\b/g, 'sacapunta')
    .replace(/\bsketch book\b/g, 'sketchbook')
    .replace(/\s+/g, ' ')
    .trim()
}

const MINOR_WORDS = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'y', 'e', 'o', 'u', 'por', 'para', 'con', 'sin', 'en'])

const MANUAL_CATEGORY_NAME_BY_KEY = new Map([
  ['cuaderno', 'Cuaderno'],
  ['juego didactico', 'Juegos Didacticos'],
  ['plumon', 'Plumon'],
  ['silicona', 'Silicona'],
  ['plastilina', 'Plastilina'],
  ['crayon', 'Crayones'],
  ['corrector', 'Corrector'],
  ['sacapunta', 'Sacapunta'],
  ['sketchbook', 'Sketchbook'],
  ['tapaboca', 'Tapaboca'],
  ['bajalengua', 'Bajalengua'],
  ['toalla', 'Toalla']
])

function titleCase(input) {
  const normalized = String(input || '')
    .trim()
    .replace(/\s+/g, ' ')
  if (!normalized) return ''
  const parts = normalized.toLowerCase().split(' ')
  return parts
    .map((word, idx) => {
      if (idx > 0 && MINOR_WORDS.has(word)) return word
      return word.charAt(0).toUpperCase() + word.slice(1)
    })
    .join(' ')
}

function choosePreferredCategoryName(group) {
  const canonical = canonicalCategoryKey(group[0]?.name)
  if (MANUAL_CATEGORY_NAME_BY_KEY.has(canonical)) {
    return MANUAL_CATEGORY_NAME_BY_KEY.get(canonical)
  }
  const sorted = [...group].sort((a, b) => {
    const lenA = String(a.name || '').trim().length
    const lenB = String(b.name || '').trim().length
    if (lenA !== lenB) return lenA - lenB
    return String(a.name || '').localeCompare(String(b.name || ''), 'es', { sensitivity: 'base' })
  })
  const base = String(sorted[0]?.name || '').trim()
  return titleCase(base)
}

const PRODUCT_STOPWORDS = new Set([
  'de', 'del', 'la', 'las', 'el', 'los', 'y', 'e', 'o', 'u', 'para', 'con', 'sin', 'por', 'en',
  'x', 'un', 'una', 'uno', 'set', 'pack', 'tipo', 'modelo', 'unidad', 'und', 'docena', 'caja',
  'cajita', 'cajitas', 'bolsa', 'bolsas', 'pqte', 'paquete', 'ciento'
])

const NEW_CATEGORY_BLOCKED_TOKENS = new Set([
  'color', 'diseno', 'nino', 'nina', 'ninos', 'ninas', 'grande', 'pequeno', 'mediano',
  'tira', 'tapa', 'rosa', 'llaj', 'llaje', 'modelo', 'personal', 'premium', 'normal'
])

function tokenizeProductText(value) {
  return normalizeText(value)
    .split(' ')
    .filter(Boolean)
    .map((token) => singularizeToken(token))
    .filter((token) => token.length >= 3 && !PRODUCT_STOPWORDS.has(token))
}

function toProductMeta(product) {
  const text = `${product.name || ''} ${product.brand || ''} ${product.product_type || ''}`
  const textNorm = normalizeText(text)
  const tokens = tokenizeProductText(text)
  return {
    textNorm,
    tokenSet: new Set(tokens),
    productTypeKey: canonicalCategoryKey(product.product_type || '')
  }
}

function scoreCategoryForProduct(productMeta, categoryMeta) {
  let score = 0
  let reason = 'token'

  if (productMeta.productTypeKey && productMeta.productTypeKey === categoryMeta.key) {
    score += 10
    reason = 'product_type_exact'
  } else if (
    productMeta.productTypeKey &&
    categoryMeta.key &&
    (
      productMeta.productTypeKey.includes(categoryMeta.key) ||
      categoryMeta.key.includes(productMeta.productTypeKey)
    ) &&
    Math.min(productMeta.productTypeKey.length, categoryMeta.key.length) >= 4
  ) {
    score += 6
    reason = 'product_type_partial'
  }

  if (categoryMeta.key && productMeta.textNorm.includes(categoryMeta.key) && categoryMeta.key.length >= 4) {
    score += 4
    if (reason === 'token') reason = 'phrase_match'
  }

  let tokenHits = 0
  for (const token of categoryMeta.tokens) {
    if (productMeta.tokenSet.has(token)) tokenHits += 1
  }
  score += Math.min(tokenHits, 3)

  if (categoryMeta.key === 'otro' || categoryMeta.key === 'vario' || categoryMeta.key === 'general') {
    score -= 1
  }

  if (
    (categoryMeta.key === 'color' || categoryMeta.key === 'papel') &&
    reason !== 'product_type_exact' &&
    reason !== 'product_type_partial'
  ) {
    score -= 2
  }

  return { score, reason, tokenHits }
}

function collectFirstMeaningfulToken(name) {
  const normalized = normalizeText(name || '')
  if (normalized.includes('tapa boca')) return 'tapaboca'
  if (normalized.includes('baja lengua')) return 'bajalengua'

  const tokens = tokenizeProductText(name || '')
  return (
    tokens.find((token) => token.length >= 4 && !NEW_CATEGORY_BLOCKED_TOKENS.has(token)) ||
    null
  )
}

async function main() {
  loadEnvFile(path.resolve(process.cwd(), '.env'))

  const supabaseUrl = process.env.SUPABASE_URL || process.env.NUXT_PUBLIC_SUPABASE_URL
  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.NUXT_PUBLIC_SUPABASE_ANON_KEY

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing Supabase credentials in .env')
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  })

  const [{ data: categories, error: categoriesError }, { data: products, error: productsError }] = await Promise.all([
    supabase
      .from('product_categories')
      .select('id, code, name, active, sort_order, created_at, updated_at')
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true }),
    supabase
      .from('products')
      .select('id, sku, name, brand, product_type, category_id')
      .order('name', { ascending: true })
  ])

  if (categoriesError) throw categoriesError
  if (productsError) throw productsError

  const productCountByCategory = new Map()
  for (const product of products) {
    if (!product.category_id) continue
    productCountByCategory.set(product.category_id, (productCountByCategory.get(product.category_id) || 0) + 1)
  }

  const categoryGroups = new Map()
  for (const category of categories) {
    const key = canonicalCategoryKey(category.name)
    if (!key) continue
    const list = categoryGroups.get(key) || []
    list.push(category)
    categoryGroups.set(key, list)
  }

  function rankCategories(a, b) {
    const countA = productCountByCategory.get(a.id) || 0
    const countB = productCountByCategory.get(b.id) || 0
    if (countA !== countB) return countB - countA

    const activeA = a.active ? 1 : 0
    const activeB = b.active ? 1 : 0
    if (activeA !== activeB) return activeB - activeA

    const sortA = Number.isFinite(a.sort_order) ? a.sort_order : Number.MAX_SAFE_INTEGER
    const sortB = Number.isFinite(b.sort_order) ? b.sort_order : Number.MAX_SAFE_INTEGER
    if (sortA !== sortB) return sortA - sortB

    return String(a.name || '').localeCompare(String(b.name || ''), 'es', { sensitivity: 'base' })
  }

  const categoryIdMap = new Map()
  const mergeActions = []
  const renameActions = []
  const normalizedCategories = []

  for (const [key, group] of categoryGroups.entries()) {
    const ranked = [...group].sort(rankCategories)
    const master = ranked[0]
    const preferredName = choosePreferredCategoryName(group)

    categoryIdMap.set(master.id, master.id)
    normalizedCategories.push({
      id: master.id,
      name: preferredName || master.name,
      key,
      tokens: tokenizeProductText(preferredName || master.name)
    })

    if ((master.name || '').trim() !== (preferredName || '').trim()) {
      renameActions.push({
        id: master.id,
        from: master.name,
        to: preferredName
      })
    }

    for (const duplicate of ranked.slice(1)) {
      categoryIdMap.set(duplicate.id, master.id)
      mergeActions.push({
        fromId: duplicate.id,
        fromName: duplicate.name,
        toId: master.id,
        toName: preferredName || master.name,
        movedProducts: productCountByCategory.get(duplicate.id) || 0
      })
    }
  }

  const uncategorizedBefore = products.filter((product) => !product.category_id)

  const categoryMetaById = new Map(
    normalizedCategories.map((category) => [category.id, category])
  )

  const highConfidenceAssignments = []
  const lowConfidenceSuggestions = []
  const unresolved = []

  for (const product of uncategorizedBefore) {
    const meta = toProductMeta(product)
    let best = null
    let second = null

    for (const category of normalizedCategories) {
      const scored = scoreCategoryForProduct(meta, category)
      if (!best || scored.score > best.score) {
        second = best
        best = { ...scored, category }
      } else if (!second || scored.score > second.score) {
        second = { ...scored, category }
      }
    }

    const bestScore = best?.score || 0
    const secondScore = second?.score || 0
    const margin = bestScore - secondScore

    if (best && (bestScore >= 8 || (bestScore >= 5 && margin >= 2) || (bestScore >= 4 && best.reason.startsWith('product_type')))) {
      highConfidenceAssignments.push({
        productId: product.id,
        sku: product.sku,
        name: product.name,
        brand: product.brand,
        productType: product.product_type,
        categoryId: best.category.id,
        categoryName: best.category.name,
        score: best.score,
        margin,
        reason: best.reason
      })
      continue
    }

    if (best && bestScore >= 3) {
      lowConfidenceSuggestions.push({
        productId: product.id,
        sku: product.sku,
        name: product.name,
        brand: product.brand,
        productType: product.product_type,
        suggestedCategoryId: best.category.id,
        suggestedCategoryName: best.category.name,
        score: best.score,
        margin,
        reason: best.reason
      })
      continue
    }

    unresolved.push({
      productId: product.id,
      sku: product.sku,
      name: product.name,
      brand: product.brand,
      productType: product.product_type
    })
  }

  const newCategoryBuckets = new Map()
  for (const item of unresolved) {
    const typeCandidate = titleCase(String(item.productType || '').trim())
    if (typeCandidate && typeCandidate.length >= 4) {
      const key = canonicalCategoryKey(typeCandidate)
      if (key) {
        const bucket = newCategoryBuckets.get(key) || {
          key,
          name: typeCandidate,
          source: 'product_type',
          productIds: []
        }
        bucket.productIds.push(item.productId)
        newCategoryBuckets.set(key, bucket)
        continue
      }
    }

    const token = collectFirstMeaningfulToken(item.name)
    if (!token) continue
    const name = titleCase(token)
    const key = canonicalCategoryKey(name)
    if (!key) continue
    const bucket = newCategoryBuckets.get(key) || {
      key,
      name,
      source: 'name_cluster',
      productIds: []
    }
    bucket.productIds.push(item.productId)
    newCategoryBuckets.set(key, bucket)
  }

  const existingCategoryKeys = new Set(normalizedCategories.map((category) => category.key))
  const newCategoriesPlan = [...newCategoryBuckets.values()]
    .filter((bucket) => !existingCategoryKeys.has(bucket.key))
    .filter((bucket) => !NEW_CATEGORY_BLOCKED_TOKENS.has(bucket.key))
    .filter((bucket) => bucket.source === 'product_type' || bucket.productIds.length >= NEW_CATEGORY_MIN_SIZE)

  const productsPlannedForNewCategories = new Set()
  const assignmentsFromNewCategoriesPlan = []
  for (const plan of newCategoriesPlan) {
    for (const productId of plan.productIds) {
      productsPlannedForNewCategories.add(productId)
      assignmentsFromNewCategoriesPlan.push({
        productId,
        categoryName: plan.name,
        source: plan.source
      })
    }
  }

  const unresolvedAfterPlan = unresolved.filter((item) => !productsPlannedForNewCategories.has(item.productId))

  const report = {
    generatedAt: new Date().toISOString(),
    mode: APPLY ? 'apply' : 'dry-run',
    totals: {
      products: products.length,
      categories: categories.length,
      uncategorizedBefore: uncategorizedBefore.length,
      highConfidenceAssignments: highConfidenceAssignments.length,
      lowConfidenceSuggestions: lowConfidenceSuggestions.length,
      newCategoriesPlanned: newCategoriesPlan.length,
      assignmentsPlannedViaNewCategories: assignmentsFromNewCategoriesPlan.length,
      unresolvedAfterPlan: unresolvedAfterPlan.length
    },
    categoryMerges: mergeActions,
    categoryRenames: renameActions,
    uncategorizedBefore: uncategorizedBefore.map((product) => ({
      id: product.id,
      sku: product.sku,
      name: product.name,
      brand: product.brand,
      product_type: product.product_type
    })),
    highConfidenceAssignments,
    lowConfidenceSuggestions,
    newCategoriesPlan: newCategoriesPlan.map((plan) => ({
      key: plan.key,
      name: plan.name,
      source: plan.source,
      products: plan.productIds.length,
      productIds: plan.productIds
    })),
    unresolvedAfterPlan
  }

  if (APPLY) {
    for (const action of mergeActions) {
      const { error: reassignError } = await supabase
        .from('products')
        .update({ category_id: action.toId })
        .eq('category_id', action.fromId)
      if (reassignError) throw reassignError

      const { error: deactivateError } = await supabase
        .from('product_categories')
        .update({ active: false, updated_at: new Date().toISOString() })
        .eq('id', action.fromId)
      if (deactivateError) throw deactivateError
    }

    for (const action of renameActions) {
      const { error: renameError } = await supabase
        .from('product_categories')
        .update({ name: action.to, updated_at: new Date().toISOString() })
        .eq('id', action.id)
      if (renameError) throw renameError
    }

    for (const assignment of highConfidenceAssignments) {
      const { error } = await supabase
        .from('products')
        .update({ category_id: assignment.categoryId })
        .eq('id', assignment.productId)
      if (error) throw error
    }

    const createdCategories = []
    for (const plan of newCategoriesPlan) {
      const { data: categoryId, error: ensureError } = await supabase.rpc('ensure_product_category', {
        p_name: plan.name
      })
      if (ensureError) throw ensureError

      const { error: assignError } = await supabase
        .from('products')
        .update({ category_id: categoryId })
        .in('id', plan.productIds)
      if (assignError) throw assignError

      createdCategories.push({
        id: categoryId,
        name: plan.name,
        products: plan.productIds.length,
        source: plan.source
      })
    }

    const categoryNamesToSync = new Map()
    for (const action of renameActions) categoryNamesToSync.set(action.id, action.to)
    for (const item of normalizedCategories) {
      if (!categoryNamesToSync.has(item.id)) categoryNamesToSync.set(item.id, item.name)
    }

    for (const [categoryId, categoryName] of categoryNamesToSync.entries()) {
      const { error } = await supabase
        .from('products')
        .update({ product_type: categoryName })
        .eq('category_id', categoryId)
      if (error) throw error
    }

    const { count: uncategorizedAfter, error: uncategorizedAfterError } = await supabase
      .from('products')
      .select('id', { count: 'exact', head: true })
      .is('category_id', null)
    if (uncategorizedAfterError) throw uncategorizedAfterError

    report.createdCategories = createdCategories
    report.totals.uncategorizedAfter = uncategorizedAfter || 0
  }

  const output = JSON.stringify(report, null, 2)
  console.log(output)

  if (WRITE_REPORT) {
    const outPath = path.resolve(process.cwd(), 'supabase', 'category_normalization_report.json')
    fs.writeFileSync(outPath, `${output}\n`, 'utf8')
    console.error(`Report written to ${outPath}`)
  }
}

main().catch((error) => {
  const message = error?.message || String(error)
  console.error(`ERROR: ${message}`)
  process.exit(1)
})
