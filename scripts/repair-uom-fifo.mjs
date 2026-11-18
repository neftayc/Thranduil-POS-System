import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const MODE = process.argv.includes('--apply') ? 'apply' : 'dry-run'
const STANDARD_START = '2026-03-09T05:00:00.000Z'
const STANDARD_END = '2026-07-04T05:00:00.000Z'
const EPSILON = 0.0005

const supabaseUrl = process.env.SUPABASE_URL || process.env.NUXT_PUBLIC_SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Faltan SUPABASE_URL/NUXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE')
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false }
})

const toNumber = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const round = (value, digits) => Number(toNumber(value).toFixed(digits))
const norm = (value) => String(value || '').trim().toLowerCase()
const key = (...parts) => parts.map((part) => String(part || '')).join('::')

const fetchAll = async (table, select, build = (query) => query) => {
  const rows = []
  let from = 0
  const pageSize = 1000

  while (true) {
    const to = from + pageSize - 1
    const { data, error } = await build(supabase.from(table).select(select)).range(from, to)
    if (error) throw error
    const batch = data || []
    rows.push(...batch)
    if (batch.length < pageSize) break
    from += pageSize
  }

  return rows
}

const relationOne = (row, relation) => {
  const value = row?.[relation]
  return Array.isArray(value) ? value[0] || null : value || null
}

const loadData = async () => {
  const [
    products,
    conversions,
    purchases,
    purchaseItems,
    sales,
    saleItems,
    stockMovements,
    inventoryBalances,
    currentAllocations
  ] = await Promise.all([
    fetchAll('products', 'id, sku, name, unit, stock_on_hand, avg_cost, sale_price'),
    fetchAll('product_unit_conversions', 'product_id, unit_name, factor_to_base, is_active', (query) =>
      query.eq('is_active', true)
    ),
    fetchAll('purchases', 'id, purchase_date, created_at, created_by, total_cost'),
    fetchAll(
      'purchase_items',
      'id, purchase_id, product_id, unit_name, qty_uom, factor_to_base, cost_unit_uom, qty, cost_unit, total_cost, created_at'
    ),
    fetchAll('sales', 'id, sale_date, created_at, total'),
    fetchAll(
      'sale_items',
      'id, sale_id, product_id, unit_name, qty_uom, factor_to_base, price_unit_uom, qty, price_unit, total, created_at'
    ),
    fetchAll('stock_movements', 'id, product_id, movement_type, qty, cost_unit, ref_table, ref_id, created_at'),
    fetchAll('inventory_balances', 'product_id, stock_on_hand, avg_cost, min_stock, updated_at'),
    fetchAll('sale_cost_allocations', 'id, sale_id, sale_item_id, product_id, qty, cost_unit, total_cost, created_at')
  ])

  return { products, conversions, purchases, purchaseItems, sales, saleItems, stockMovements, inventoryBalances, currentAllocations }
}

const buildContext = (data) => {
  const productsById = new Map(data.products.map((product) => [product.id, product]))
  const purchasesById = new Map(data.purchases.map((purchase) => [purchase.id, purchase]))
  const salesById = new Map(data.sales.map((sale) => [sale.id, sale]))
  const balancesByProduct = new Map(data.inventoryBalances.map((balance) => [balance.product_id, balance]))
  const conversionByProductUnit = new Map(
    data.conversions.map((conversion) => [
      key(conversion.product_id, norm(conversion.unit_name)),
      toNumber(conversion.factor_to_base)
    ])
  )

  return { productsById, purchasesById, salesById, balancesByProduct, conversionByProductUnit }
}

const factorFor = (product, unitName, storedFactor, conversionByProductUnit) => {
  const unitCode = norm(unitName)
  const baseUnitCode = norm(product?.unit || 'unidad')
  const catalogFactor = conversionByProductUnit.get(key(product?.id, unitCode))

  if (!unitCode || unitCode === baseUnitCode) return 1
  if (catalogFactor > 0) return catalogFactor
  if (toNumber(storedFactor) > 0) return toNumber(storedFactor)
  return 1
}

const normalizedPurchase = (item, ctx) => {
  const product = ctx.productsById.get(item.product_id)
  const factor = factorFor(product, item.unit_name, item.factor_to_base, ctx.conversionByProductUnit)
  const qtyUom =
    toNumber(item.qty_uom) > 0
      ? toNumber(item.qty_uom)
      : factor > 0 && toNumber(item.qty) > 0
        ? toNumber(item.qty) / factor
        : 0
  const totalCost = toNumber(item.total_cost)
  const qtyBase = qtyUom * factor
  const costUnitUom =
    toNumber(item.cost_unit_uom) > 0
      ? toNumber(item.cost_unit_uom)
      : qtyUom > 0
        ? totalCost / qtyUom
        : toNumber(item.cost_unit) * factor
  const costUnit = qtyBase > 0 ? totalCost / qtyBase : 0

  return {
    ...item,
    normalized_unit_name: norm(item.unit_name || product?.unit || 'unidad'),
    normalized_factor_to_base: round(factor, 6),
    normalized_qty_uom: round(qtyUom, 3),
    normalized_cost_unit_uom: round(costUnitUom, 4),
    normalized_qty: round(qtyBase, 3),
    normalized_cost_unit: round(costUnit, 4)
  }
}

const effectiveSaleQty = (item, ctx) => {
  const product = ctx.productsById.get(item.product_id)
  const factor = factorFor(product, item.unit_name, item.factor_to_base, ctx.conversionByProductUnit)
  const qtyUom = toNumber(item.qty_uom) > 0 ? toNumber(item.qty_uom) : toNumber(item.qty)
  return round(qtyUom * factor, 3)
}

const purchaseDate = (item, ctx) => {
  const purchase = ctx.purchasesById.get(item.purchase_id)
  return purchase?.purchase_date || purchase?.created_at || item.created_at || new Date(0).toISOString()
}

const saleDate = (item, ctx) => {
  const sale = ctx.salesById.get(item.sale_id)
  return sale?.sale_date || sale?.created_at || item.created_at || new Date(0).toISOString()
}

const calculateWeightedPurchaseCost = (normalizedPurchases) => {
  const totals = new Map()

  for (const item of normalizedPurchases) {
    const current = totals.get(item.product_id) || { cost: 0, qty: 0 }
    current.cost += toNumber(item.total_cost)
    current.qty += toNumber(item.normalized_qty)
    totals.set(item.product_id, current)
  }

  const costs = new Map()
  for (const [productId, value] of totals) {
    costs.set(productId, value.qty > EPSILON ? round(value.cost / value.qty, 4) : 0)
  }

  return costs
}

const rebuildInMemory = (data, ctx, normalizedPurchases, weightedCosts) => {
  const layers = []
  const allocations = []

  const currentSaleMoveCost = new Map()
  for (const movement of data.stockMovements) {
    if (movement.movement_type !== 'sale') continue
    currentSaleMoveCost.set(key(movement.ref_id, movement.product_id), toNumber(movement.cost_unit))
  }

  const purchasesForLayers = normalizedPurchases
    .filter((item) => toNumber(item.normalized_qty) > EPSILON)
    .slice()
    .sort((a, b) => {
      const dateCompare = purchaseDate(a, ctx).localeCompare(purchaseDate(b, ctx))
      if (dateCompare) return dateCompare
      return String(a.id).localeCompare(String(b.id))
    })

  let layerSeq = 0
  for (const item of purchasesForLayers) {
    layers.push({
      temp_id: `purchase:${item.id}`,
      seq: layerSeq++,
      product_id: item.product_id,
      purchase_id: item.purchase_id,
      purchase_item_id: item.id,
      source: 'purchase',
      layer_date: purchaseDate(item, ctx),
      qty_in: toNumber(item.normalized_qty),
      qty_remaining: toNumber(item.normalized_qty),
      cost_unit: toNumber(item.normalized_cost_unit)
    })
  }

  const saleItemsSorted = data.saleItems
    .filter((item) => effectiveSaleQty(item, ctx) > EPSILON)
    .slice()
    .sort((a, b) => {
      const dateCompare = saleDate(a, ctx).localeCompare(saleDate(b, ctx))
      if (dateCompare) return dateCompare
      return String(a.id).localeCompare(String(b.id))
    })

  for (const saleItem of saleItemsSorted) {
    let remaining = effectiveSaleQty(saleItem, ctx)
    const productLayers = () =>
      layers
        .filter((layer) => layer.product_id === saleItem.product_id && layer.qty_remaining > EPSILON)
        .sort((a, b) => {
          const dateCompare = layerDateSort(a).localeCompare(layerDateSort(b))
          if (dateCompare) return dateCompare
          return a.seq - b.seq
        })

    for (const layer of productLayers()) {
      if (remaining <= EPSILON) break
      const take = Math.min(remaining, layer.qty_remaining)
      if (take <= EPSILON) continue
      layer.qty_remaining = round(layer.qty_remaining - take, 3)
      allocations.push({
        sale_id: saleItem.sale_id,
        sale_item_id: saleItem.id,
        product_id: saleItem.product_id,
        layer_temp_id: layer.temp_id,
        qty: round(take, 3),
        cost_unit: round(layer.cost_unit, 4),
        total_cost: round(take * layer.cost_unit, 4),
        created_at: saleDate(saleItem, ctx)
      })
      remaining = round(remaining - take, 3)
    }

    if (remaining > EPSILON) {
      const fallbackCost =
        weightedCosts.get(saleItem.product_id) ||
        currentSaleMoveCost.get(key(saleItem.sale_id, saleItem.product_id)) ||
        toNumber(ctx.balancesByProduct.get(saleItem.product_id)?.avg_cost) ||
        0
      const fallbackLayer = {
        temp_id: `auto-balance:${saleItem.id}`,
        seq: layerSeq++,
        product_id: saleItem.product_id,
        source: 'auto-balance',
        layer_date: saleDate(saleItem, ctx),
        qty_in: remaining,
        qty_remaining: 0,
        cost_unit: round(fallbackCost, 4)
      }
      layers.push(fallbackLayer)
      allocations.push({
        sale_id: saleItem.sale_id,
        sale_item_id: saleItem.id,
        product_id: saleItem.product_id,
        layer_temp_id: fallbackLayer.temp_id,
        qty: round(remaining, 3),
        cost_unit: round(fallbackCost, 4),
        total_cost: round(remaining * fallbackCost, 4),
        created_at: saleDate(saleItem, ctx)
      })
    }
  }

  for (const balance of data.inventoryBalances) {
    const productId = balance.product_id
    const stock = toNumber(balance.stock_on_hand)
    const layerQty = layers
      .filter((layer) => layer.product_id === productId)
      .reduce((sum, layer) => sum + toNumber(layer.qty_remaining), 0)
    let diff = round(stock - layerQty, 3)

    if (diff > EPSILON) {
      layers.push({
        temp_id: `reconcile:${productId}`,
        seq: layerSeq++,
        product_id: productId,
        source: 'reconcile',
        layer_date: new Date().toISOString(),
        qty_in: diff,
        qty_remaining: diff,
        cost_unit: weightedCosts.get(productId) || toNumber(balance.avg_cost) || 0
      })
    } else if (diff < -EPSILON) {
      let remaining = Math.abs(diff)
      const reverseLayers = layers
        .filter((layer) => layer.product_id === productId && layer.qty_remaining > EPSILON)
        .sort((a, b) => {
          const dateCompare = layerDateSort(b).localeCompare(layerDateSort(a))
          if (dateCompare) return dateCompare
          return b.seq - a.seq
        })

      for (const layer of reverseLayers) {
        if (remaining <= EPSILON) break
        const take = Math.min(remaining, layer.qty_remaining)
        layer.qty_remaining = round(layer.qty_remaining - take, 3)
        remaining = round(remaining - take, 3)
      }
    }
  }

  return { layers, allocations }
}

const layerDateSort = (layer) => `${layer.layer_date || ''}:${String(layer.seq).padStart(8, '0')}`

const reportForRange = (data, ctx, allocations) => {
  const saleItemsById = new Map(data.saleItems.map((item) => [item.id, item]))
  const allocationsBySaleItem = new Map()
  for (const allocation of allocations) {
    allocationsBySaleItem.set(
      allocation.sale_item_id,
      (allocationsBySaleItem.get(allocation.sale_item_id) || 0) + toNumber(allocation.total_cost)
    )
  }

  let salesTotal = 0
  let salesCost = 0
  let saleItemsCount = 0
  for (const item of data.saleItems) {
    const date = saleDate(item, ctx)
    if (date < STANDARD_START || date >= STANDARD_END) continue
    saleItemsCount += 1
    salesTotal += toNumber(item.total)
    salesCost += allocationsBySaleItem.get(item.id) || 0
  }

  let purchasesTotal = 0
  let purchaseItemsCount = 0
  for (const item of data.purchaseItems) {
    const date = purchaseDate(item, ctx)
    if (date < STANDARD_START || date >= STANDARD_END) continue
    purchaseItemsCount += 1
    purchasesTotal += toNumber(item.total_cost)
  }

  const grossProfit = salesTotal - salesCost
  return {
    purchase_items_count: purchaseItemsCount,
    sale_items_count: saleItemsCount,
    purchases_total: round(purchasesTotal, 2),
    sales_total: round(salesTotal, 2),
    sales_cogs_total: round(salesCost, 2),
    gross_profit_total: round(grossProfit, 2),
    margin_pct: salesTotal > EPSILON ? round((grossProfit / salesTotal) * 100, 2) : 0,
    profit_ten_percent: round(grossProfit * 0.1, 2),
    net_after_profit_share: round(grossProfit * 0.9, 2)
  }
}

const summarizeCurrentReport = (data, ctx) => {
  const currentAllocations = data.currentAllocations.map((allocation) => ({
    sale_id: allocation.sale_id,
    sale_item_id: allocation.sale_item_id,
    product_id: allocation.product_id,
    qty: toNumber(allocation.qty),
    cost_unit: toNumber(allocation.cost_unit),
    total_cost: toNumber(allocation.total_cost),
    created_at: allocation.created_at
  }))
  return reportForRange(data, ctx, currentAllocations)
}

const summarizeMismatches = (data, ctx, normalizedPurchases) => {
  const mismatches = []
  for (const item of normalizedPurchases) {
    if (
      Math.abs(toNumber(item.factor_to_base) - item.normalized_factor_to_base) > EPSILON ||
      Math.abs(toNumber(item.qty) - item.normalized_qty) > EPSILON ||
      Math.abs(toNumber(item.cost_unit) - item.normalized_cost_unit) > EPSILON
    ) {
      const product = ctx.productsById.get(item.product_id)
      mismatches.push({
        id: item.id,
        sku: product?.sku || null,
        product: product?.name || null,
        unit_name: item.unit_name,
        factor_to_base: toNumber(item.factor_to_base),
        normalized_factor_to_base: item.normalized_factor_to_base,
        qty: toNumber(item.qty),
        normalized_qty: item.normalized_qty,
        cost_unit: toNumber(item.cost_unit),
        normalized_cost_unit: item.normalized_cost_unit,
        total_cost: toNumber(item.total_cost)
      })
    }
  }
  return mismatches
}

const main = async () => {
  const data = await loadData()
  const ctx = buildContext(data)
  const normalizedPurchases = data.purchaseItems.map((item) => normalizedPurchase(item, ctx))
  const weightedCosts = calculateWeightedPurchaseCost(normalizedPurchases)
  const rebuilt = rebuildInMemory(data, ctx, normalizedPurchases, weightedCosts)
  const mismatches = summarizeMismatches(data, ctx, normalizedPurchases)
  const currentReport = summarizeCurrentReport(data, ctx)
  const projectedReport = reportForRange(data, ctx, rebuilt.allocations)

  const output = {
    mode: MODE,
    purchase_items_total: data.purchaseItems.length,
    purchase_items_to_normalize: mismatches.length,
    current_report_standard_range: currentReport,
    projected_report_standard_range: projectedReport,
    delta_standard_range: {
      sales_cogs_total: round(projectedReport.sales_cogs_total - currentReport.sales_cogs_total, 2),
      gross_profit_total: round(projectedReport.gross_profit_total - currentReport.gross_profit_total, 2),
      net_after_profit_share: round(projectedReport.net_after_profit_share - currentReport.net_after_profit_share, 2)
    },
    rebuilt_layers_count: rebuilt.layers.length,
    rebuilt_allocations_count: rebuilt.allocations.length,
    examples: mismatches.slice(0, 20)
  }

  if (MODE !== 'apply') {
    console.log(JSON.stringify(output, null, 2))
    return
  }

  throw new Error('Modo apply aún no implementado: revisar dry-run antes de habilitar escrituras.')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
