<script setup lang="ts">
import * as XLSX from 'xlsx'

const products = ref<any[]>([])
const unitCatalog = ref<Array<{ code: string; label: string }>>([])
const search = ref('')
const loading = ref(false)
const inlinePriceSavingId = ref('')
const inlinePriceOriginal = ref<Record<string, number>>({})
const message = ref('')
const importMessage = ref('')
const showForm = ref(false)

const form = reactive({
  id: '',
  sku: '',
  name: '',
  brand: '',
  product_type: '',
  barcode: '',
  unit: 'unidad',
  sale_price: 0,
  stock_on_hand: 0,
  avg_cost: 0,
  min_stock: 0,
  active: true,
  unit_conversions: [] as Array<{
    unit_name: string
    factor_to_base: number
    is_active: boolean
  }>
})

const isEditing = computed(() => Boolean(form.id))

const productSummary = computed(() => {
  const total = products.value.length
  const active = products.value.filter((item) => item.active !== false).length
  const low = products.value.filter(
    (item) => Number(item.stock_on_hand || 0) <= Number(item.min_stock || 0)
  ).length

  return { total, active, low }
})

const unitOptions = computed(() => {
  if (unitCatalog.value.length) return unitCatalog.value
  return [{ code: 'unidad', label: 'Unidad' }]
})

const priceAdjust = reactive({
  mode: 'percent' as 'percent' | 'amount',
  value: 0,
  margin_pct: 30
})

const roundMoney = (value: number) => Number(Math.max(0, value).toFixed(2))

const currentMarginPct = computed(() => {
  const cost = Number(form.avg_cost || 0)
  const sale = Number(form.sale_price || 0)
  if (cost <= 0 || sale <= 0) return null
  return Number((((sale - cost) / cost) * 100).toFixed(2))
})

const applyPriceAdjustment = (direction: 'up' | 'down') => {
  const current = Number(form.sale_price || 0)
  const value = Number(priceAdjust.value || 0)
  if (!Number.isFinite(value) || value <= 0) {
    message.value = 'Ingresa un valor válido para ajustar el precio.'
    return
  }

  let next = current
  if (priceAdjust.mode === 'percent') {
    const ratio = value / 100
    next = direction === 'up' ? current * (1 + ratio) : current * (1 - ratio)
  } else {
    next = direction === 'up' ? current + value : current - value
  }

  form.sale_price = roundMoney(next)
  message.value = `Precio base actualizado a S/ ${form.sale_price.toFixed(2)}`
}

const setPriceFromMargin = () => {
  const cost = Number(form.avg_cost || 0)
  const margin = Number(priceAdjust.margin_pct || 0)

  if (!Number.isFinite(cost) || cost <= 0) {
    message.value = 'Define primero un costo promedio mayor a 0.'
    return
  }

  if (!Number.isFinite(margin) || margin < 0) {
    message.value = 'El margen debe ser 0 o mayor.'
    return
  }

  form.sale_price = roundMoney(cost * (1 + margin / 100))
  message.value = `Precio base calculado por margen: S/ ${form.sale_price.toFixed(2)}`
}

const normalizeSalePrice = (value: any) => roundMoney(Number(value || 0))

const resetForm = () => {
  form.id = ''
  form.sku = ''
  form.name = ''
  form.brand = ''
  form.product_type = ''
  form.barcode = ''
  form.unit = 'unidad'
  form.sale_price = 0
  form.stock_on_hand = 0
  form.avg_cost = 0
  form.min_stock = 0
  form.active = true
  form.unit_conversions = []
  priceAdjust.mode = 'percent'
  priceAdjust.value = 0
  priceAdjust.margin_pct = 30
}

const openCreateForm = () => {
  resetForm()
  importMessage.value = ''
  showForm.value = true
}

const closeForm = () => {
  resetForm()
  importMessage.value = ''
  showForm.value = false
}

const loadProducts = async () => {
  loading.value = true
  message.value = ''
  try {
    const data = await $fetch<{ units: any[]; products: any[] }>('/api/products/page')

    unitCatalog.value = (data.units || []).length ? (data.units as any[]) : [{ code: 'unidad', label: 'Unidad' }]
    products.value = (data.products || []).map((item) => ({
      ...item,
      sale_price: normalizeSalePrice(item.sale_price)
    }))
    inlinePriceOriginal.value = Object.fromEntries(
      products.value.map((item) => [item.id, normalizeSalePrice(item.sale_price)])
    )
  } catch (err: any) {
    message.value = err?.data?.statusMessage || err?.message || 'No se pudieron cargar productos.'
  } finally {
    loading.value = false
  }
}

const upsertCatalogProduct = async (payload: any) => {
  const res = await $fetch<{ id: string }>('/api/products/catalog-upsert', {
    method: 'POST',
    body: {
      p_id: payload.id || null,
      p_sku: payload.sku || null,
      p_name: payload.name,
      p_unit: payload.unit || 'unidad',
    p_brand: payload.brand || null,
    p_product_type: payload.product_type || null,
    p_barcode: payload.barcode || null,
    p_active: payload.active !== false,
    p_sale_price: Number(payload.sale_price || 0),
    p_min_stock: Number(payload.min_stock || 0),
    p_stock_on_hand:
      payload.stock_on_hand === null || payload.stock_on_hand === undefined
        ? null
        : Number(payload.stock_on_hand || 0),
    p_avg_cost:
      payload.avg_cost === null || payload.avg_cost === undefined
        ? null
        : Number(payload.avg_cost || 0),
    p_currency: 'PEN'
    }
  })

  return String(res.id)
}

const normalizeText = (value: any) => String(value || '').trim()
const normalizeUnitCode = (value: any) =>
  String(value || '')
    .trim()
    .toLowerCase()

const sanitizeConversions = (baseUnit: string) => {
  const base = normalizeUnitCode(baseUnit)
  const unique = new Set<string>()

  return (form.unit_conversions || [])
    .map((row) => ({
      unit_name: normalizeUnitCode(row.unit_name),
      factor_to_base: Number(row.factor_to_base || 0),
      is_active: row.is_active !== false
    }))
    .filter((row) => {
      if (!row.unit_name || row.unit_name === base) return false
      if (!Number.isFinite(row.factor_to_base) || row.factor_to_base <= 0) return false
      if (unique.has(row.unit_name)) return false
      unique.add(row.unit_name)
      return true
    })
}

const resolveUnitCode = (raw: any) => {
  const value = normalizeUnitCode(raw)
  if (!value) return 'unidad'

  const match = unitOptions.value.find((item) => {
    const label = normalizeUnitCode(item.label)
    return item.code === value || label === value || `${item.code}s` === value || `${label}s` === value
  })

  return match?.code || 'unidad'
}

const unitLabel = (code: string) => {
  const normalized = normalizeUnitCode(code)
  const found = unitOptions.value.find((item) => item.code === normalized)
  return found?.label || (normalized || 'Unidad')
}

const conversionOptions = (currentCode = '') => {
  const current = normalizeUnitCode(currentCode)
  const base = normalizeUnitCode(form.unit)
  const used = new Set(
    form.unit_conversions
      .map((row) => normalizeUnitCode(row.unit_name))
      .filter((code) => code && code !== current)
  )

  return unitOptions.value.filter((item) => item.code !== base && (!used.has(item.code) || item.code === current))
}

const syncProductConversions = async (productId: string, baseUnit: string) => {
  const payload = sanitizeConversions(baseUnit)
  await $fetch('/api/products/conversions-replace', {
    method: 'POST',
    body: {
      p_product_id: productId,
      p_items: payload
    }
  })
}

const saveProduct = async () => {
  loading.value = true
  message.value = ''
  try {
    const baseUnit = resolveUnitCode(form.unit || 'unidad')
    form.unit = baseUnit
    const productId = await upsertCatalogProduct(form)
    await syncProductConversions(productId, baseUnit)
    await loadProducts()
    resetForm()
    showForm.value = false
    message.value = 'Producto guardado correctamente.'
  } catch (err: any) {
    message.value = err?.message || 'No se pudo guardar el producto.'
  } finally {
    loading.value = false
  }
}

const saveInlineBasePrice = async (product: any) => {
  if (!product?.id) return

  const productId = String(product.id)
  if (inlinePriceSavingId.value === productId) return
  const nextPrice = normalizeSalePrice(product.sale_price)
  const previousPrice = normalizeSalePrice(inlinePriceOriginal.value[productId] ?? product.sale_price)
  product.sale_price = nextPrice

  if (nextPrice === previousPrice) return

  inlinePriceSavingId.value = productId
  message.value = ''
  try {
    await upsertCatalogProduct({
      ...product,
      sale_price: nextPrice
    })
    inlinePriceOriginal.value[productId] = nextPrice
    message.value = `Precio base actualizado: ${product.name} (S/ ${nextPrice.toFixed(2)})`
  } catch (err: any) {
    product.sale_price = previousPrice
    message.value = err?.message || 'No se pudo actualizar el precio base.'
  } finally {
    inlinePriceSavingId.value = ''
  }
}

const loadProductConversions = async (productId: string, baseUnit: string) => {
  const res = await $fetch<{ items: any[] }>(`/api/products/${productId}/conversions`)

  const baseCode = normalizeUnitCode(baseUnit)
  form.unit_conversions = (res.items || [])
    .map((row) => ({
      unit_name: normalizeUnitCode(row.unit_name),
      factor_to_base: Number(row.factor_to_base || 0),
      is_active: row.is_active !== false
    }))
    .filter((row) => row.unit_name !== baseCode)
}

const addConversionRow = () => {
  form.unit_conversions.push({
    unit_name: '',
    factor_to_base: 1,
    is_active: true
  })
}

const removeConversionRow = (index: number) => {
  form.unit_conversions.splice(index, 1)
}

const editProduct = async (product: any) => {
  form.id = product.id
  form.sku = product.sku || ''
  form.name = product.name || ''
  form.brand = product.brand || ''
  form.product_type = product.product_type || ''
  form.barcode = product.barcode || ''
  form.unit = resolveUnitCode(product.unit || 'unidad')
  form.sale_price = Number(product.sale_price || 0)
  form.stock_on_hand = Number(product.stock_on_hand || 0)
  form.avg_cost = Number(product.avg_cost || 0)
  form.min_stock = Number(product.min_stock || 0)
  form.active = product.active !== false
  form.unit_conversions = []
  try {
    await loadProductConversions(product.id, form.unit || 'unidad')
  } catch (err: any) {
    message.value = err?.data?.statusMessage || err?.message || 'No se pudieron cargar las presentaciones.'
  }
  showForm.value = true
}

const filteredProducts = computed(() => {
  const term = search.value.toLowerCase().trim()
  if (!term) return products.value

  return products.value.filter((p) =>
    `${p.name || ''} ${p.sku || ''} ${p.brand || ''} ${p.product_type || ''}`
      .toLowerCase()
      .includes(term)
  )
})

const normalizeKey = (value: string) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

const normalizeRowKeys = (row: Record<string, any>) => {
  const mapped: Record<string, any> = {}
  Object.entries(row || {}).forEach(([key, value]) => {
    mapped[normalizeKey(key)] = value
  })
  return mapped
}

const pickField = (row: Record<string, any>, aliases: string[]) => {
  for (const alias of aliases) {
    const key = normalizeKey(alias)
    if (Object.prototype.hasOwnProperty.call(row, key)) {
      const value = row[key]
      if (value !== null && value !== undefined && String(value).trim() !== '') {
        return value
      }
    }
  }

  return ''
}

const parseNumeric = (input: any) => {
  if (typeof input === 'number') return Number.isFinite(input) ? input : 0
  const raw = String(input || '').trim()
  if (!raw) return 0

  const compact = raw.replace(/\s+/g, '')
  if (/^-?\d{1,3}(\.\d{3})*(,\d+)?$/.test(compact)) {
    return Number(compact.replace(/\./g, '').replace(',', '.')) || 0
  }
  if (/^-?\d{1,3}(,\d{3})*(\.\d+)?$/.test(compact)) {
    return Number(compact.replace(/,/g, '')) || 0
  }
  return Number(compact.replace(',', '.')) || 0
}

const scoreSheet = (rows: any[]) => {
  if (!rows.length) return -1
  const keys = Object.keys(rows[0]).map(normalizeKey)

  let score = 0
  if (keys.some((k) => ['nombre_del_elemento', 'nombre', 'producto'].includes(k))) score += 60
  if (keys.some((k) => ['id_de_articulo', 'codigo', 'sku'].includes(k))) score += 20
  if (keys.some((k) => ['count', 'stock', 'cantidad', 'stok'].includes(k))) score += 10
  if (keys.some((k) => ['precio_de_venta_sugerido', 'precio_venta', 'precio'].includes(k))) score += 10

  return score
}

const selectBestSheetRows = (workbook: XLSX.WorkBook) => {
  let bestRows: any[] = []
  let bestSheetName = ''
  let bestScore = -1

  workbook.SheetNames.forEach((sheetName) => {
    const sheet = workbook.Sheets[sheetName]
    if (!sheet) return
    const rows: any[] = XLSX.utils.sheet_to_json(sheet, { defval: '' })
    const score = scoreSheet(rows)
    if (score > bestScore) {
      bestRows = rows
      bestSheetName = sheetName
      bestScore = score
    }
  })

  return { rows: bestRows, sheetName: bestSheetName, score: bestScore }
}

const cleanSku = (value: string) => {
  const normalized = String(value || '').trim()
  if (!normalized) return ''
  if (normalizeKey(normalized) === 'nuevo') return ''
  return normalized
}

const makeAutoSku = (name: string, index: number) => {
  const base = String(name || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, 8)
  return `AUTO-${base || 'ITEM'}-${String(index + 1).padStart(4, '0')}`
}

const importFromExcel = async (event: Event) => {
  importMessage.value = ''
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return

  loading.value = true
  try {
    const buffer = await file.arrayBuffer()
    const workbook = XLSX.read(buffer, { type: 'array' })
    const selected = selectBestSheetRows(workbook)
    const rows = selected.rows

    if (!rows.length || selected.score < 0) {
      importMessage.value = 'No se encontró una hoja válida para importar.'
      return
    }

    const normalized = rows
      .map((row, index) => {
        const mapped = normalizeRowKeys(row)
        const rawSku = String(
          pickField(mapped, ['id de articulo', 'codigo', 'sku', 'id articulo']) || ''
        )
        const sku =
          cleanSku(rawSku) ||
          makeAutoSku(String(pickField(mapped, ['nombre del elemento', 'nombre', 'producto']) || ''), index)

        const name = String(
          pickField(mapped, ['nombre del elemento', 'nombre', 'producto']) || ''
        ).trim()

        const salePrice = pickField(mapped, [
          'precio de venta sugerido',
          'precio_venta',
          'precio de venta',
          'precio'
        ])
        const avgCost = pickField(mapped, [
          'precio por unidad',
          'costo unitario',
          'costo',
          'costo promedio'
        ])
        const stock = pickField(mapped, ['stock', 'stok', '#', 'cantidad', 'count'])
        const minStock = pickField(mapped, ['min_stock', 'stock minimo', 'minimo'])
        const rawUnit = String(
          pickField(mapped, ['unidad de venta', 'unidad medida', 'unidad']) || 'unidad'
        ).trim()
        const brand = String(pickField(mapped, ['marca', 'brand']) || '').trim()
        const productType = String(pickField(mapped, ['tipo', 'categoria', 'product_type']) || '').trim()
        const barcode = String(
          pickField(mapped, ['barcode', 'codigo barras', 'codigo_de_barras']) || ''
        ).trim()

        return {
          sku,
          name,
          unit: resolveUnitCode(rawUnit || 'unidad'),
          brand,
          product_type: productType,
          barcode,
          sale_price: parseNumeric(salePrice),
          stock_on_hand: parseNumeric(stock),
          avg_cost: parseNumeric(avgCost),
          min_stock: parseNumeric(minStock),
          active: true
        }
      })
      .filter((row) => row.name)

    if (!normalized.length) {
      importMessage.value = 'No se encontraron filas válidas.'
      return
    }

    const batchSize = 30
    for (let i = 0; i < normalized.length; i += batchSize) {
      const batch = normalized.slice(i, i + batchSize)
      await Promise.all(batch.map((row) => upsertCatalogProduct(row)))
    }

    importMessage.value = `Importados ${normalized.length} productos desde "${selected.sheetName}".`
    await loadProducts()
  } catch (err: any) {
    importMessage.value = err?.message || 'Error al importar.'
  } finally {
    loading.value = false
    input.value = ''
  }
}

onMounted(loadProducts)
</script>

<template>
  <div class="space-y-6">
    <section class="ui-card">
      <div class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 class="ui-heading">Listado de productos</h2>
          <p class="ui-meta-chip mt-2">{{ filteredProducts.length }} resultados</p>
          <div class="mt-2 flex flex-wrap gap-2">
            <span class="ui-pill">Total: {{ productSummary.total }}</span>
            <span class="ui-pill">Activos: {{ productSummary.active }}</span>
            <span class="ui-pill ui-pill-low">Stock bajo: {{ productSummary.low }}</span>
          </div>
        </div>

        <div class="flex w-full flex-col items-stretch gap-3 sm:w-auto sm:flex-row sm:items-center">
          <input
            v-model="search"
            class="ui-input w-full sm:w-72"
            type="text"
            placeholder="Buscar por nombre, código, marca o tipo"
          />
          <button class="ui-btn" @click="openCreateForm">Añadir producto</button>
        </div>
      </div>

      <div
        v-if="message"
        class="mt-4"
        :class="message.toLowerCase().includes('no se pudo') ? 'ui-alert-error' : 'ui-alert'"
      >
        {{ message }}
      </div>

      <div class="ui-table-wrap mt-5">
        <table class="ui-table">
          <thead>
            <tr>
              <th>Código</th>
              <th>Producto</th>
              <th>Marca</th>
              <th>Unidad base</th>
              <th>Precio base venta</th>
              <th>Stock actual</th>
              <th>Estado</th>
              <th>Acción</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="product in filteredProducts" :key="product.id">
              <td>{{ product.sku || '-' }}</td>
              <td>
                <p class="font-semibold text-slate-800">{{ product.name }}</p>
                <p class="text-xs text-slate-400">{{ product.product_type || 'Sin categoría' }}</p>
              </td>
              <td>{{ product.brand || '-' }}</td>
              <td>{{ unitLabel(product.unit || 'unidad') }}</td>
              <td>
                <div class="flex items-center gap-2">
                  <input
                    v-model.number="product.sale_price"
                    class="ui-input h-9 w-28 px-2 py-1.5 text-sm"
                    type="number"
                    min="0"
                    step="0.01"
                    :disabled="inlinePriceSavingId === product.id"
                    @blur="saveInlineBasePrice(product)"
                    @keydown.enter.prevent="saveInlineBasePrice(product)"
                  />
                </div>
                <p v-if="inlinePriceSavingId === product.id" class="mt-1 text-[11px] text-slate-500">Guardando...</p>
              </td>
              <td>
                <span
                  class="ui-pill"
                  :class="Number(product.stock_on_hand || 0) <= Number(product.min_stock || 0) ? 'ui-pill-low' : ''"
                >
                  {{ Number(product.stock_on_hand || 0).toFixed(2) }}
                </span>
              </td>
              <td>
                <span
                  class="inline-flex rounded-full px-2.5 py-1 text-xs font-semibold"
                  :class="product.active === false ? 'bg-slate-100 text-slate-600' : 'bg-emerald-100 text-emerald-500'"
                >
                  {{ product.active === false ? 'Inactivo' : 'Activo' }}
                </span>
              </td>
              <td>
                <button class="ui-btn-secondary px-3 py-2" @click="editProduct(product)">Editar</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p v-if="!filteredProducts.length && !loading" class="ui-empty-state mt-4">
        No hay productos que coincidan con la búsqueda.
      </p>
    </section>

    <section v-if="showForm" class="grid gap-6 xl:grid-cols-[1fr_1.1fr]">
      <article class="ui-card">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 class="ui-heading">{{ isEditing ? 'Editar producto' : 'Nuevo producto' }}</h2>
            <p class="ui-subtitle">Completa catálogo, precio base y datos de inventario.</p>
          </div>
          <button class="ui-btn-secondary" @click="closeForm">Cerrar</button>
        </div>

        <div class="mt-5 grid gap-4 sm:grid-cols-2">
          <div>
            <label class="ui-label">Código</label>
            <input v-model="form.sku" class="ui-input" type="text" placeholder="Ej: LAP-001" />
          </div>
          <div>
            <label class="ui-label">Nombre</label>
            <input v-model="form.name" class="ui-input" type="text" placeholder="Ej: Lápiz HB" />
          </div>
          <div>
            <label class="ui-label">Marca</label>
            <input v-model="form.brand" class="ui-input" type="text" placeholder="Ej: Artesco" />
          </div>
          <div>
            <label class="ui-label">Tipo / categoría</label>
            <input v-model="form.product_type" class="ui-input" type="text" placeholder="Ej: Útiles" />
          </div>
          <div>
            <label class="ui-label">Unidad base del producto</label>
            <select v-model="form.unit" class="ui-select">
              <option v-for="option in unitOptions" :key="option.code" :value="option.code">
                {{ option.label }}
              </option>
            </select>
          </div>
          <div>
            <label class="ui-label">Código de barras</label>
            <input v-model="form.barcode" class="ui-input" type="text" placeholder="Opcional" />
          </div>
          <div>
            <label class="ui-label">Precio base de venta (S/ por unidad base)</label>
            <input v-model.number="form.sale_price" class="ui-input" type="number" min="0" step="0.01" />
            <p class="mt-1 text-xs text-slate-400">
              Este es el precio normal. Precios especiales se configuran en <strong>Reglas de venta</strong>.
            </p>
          </div>
          <div>
            <label class="ui-label">Stock actual (inventario)</label>
            <input v-model.number="form.stock_on_hand" class="ui-input" type="number" min="0" step="0.01" />
          </div>
          <div>
            <label class="ui-label">Costo promedio actual (S/)</label>
            <input v-model.number="form.avg_cost" class="ui-input" type="number" min="0" step="0.0001" />
          </div>
          <div>
            <label class="ui-label">Stock mínimo</label>
            <input v-model.number="form.min_stock" class="ui-input" type="number" min="0" step="0.01" />
          </div>
          <div class="sm:col-span-2">
            <div class="ui-subcard">
              <div class="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p class="text-sm font-semibold text-slate-800">Ajuste de precio base</p>
                  <p class="text-xs text-slate-400">
                    Precio actual: <span class="font-semibold text-indigo-600">S/ {{ Number(form.sale_price || 0).toFixed(2) }}</span>
                    <span v-if="currentMarginPct !== null" class="ml-2">Margen estimado: {{ currentMarginPct }}%</span>
                  </p>
                </div>
              </div>

              <div class="mt-4 grid gap-3 sm:grid-cols-[160px_180px_auto_auto]">
                <select v-model="priceAdjust.mode" class="ui-select">
                  <option value="percent">Porcentaje (%)</option>
                  <option value="amount">Monto (S/)</option>
                </select>
                <input
                  v-model.number="priceAdjust.value"
                  class="ui-input"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="Valor de ajuste"
                />
                <button type="button" class="ui-btn-secondary px-3 py-2" @click="applyPriceAdjustment('up')">
                  Subir precio
                </button>
                <button type="button" class="ui-btn-secondary px-3 py-2" @click="applyPriceAdjustment('down')">
                  Bajar precio
                </button>
              </div>

              <div class="mt-3 grid gap-3 sm:grid-cols-[220px_auto]">
                <input
                  v-model.number="priceAdjust.margin_pct"
                  class="ui-input"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="Margen deseado (%)"
                />
                <button type="button" class="ui-btn-secondary px-3 py-2" @click="setPriceFromMargin">
                  Calcular desde costo promedio
                </button>
              </div>
            </div>
          </div>
          <div>
            <label class="ui-label">Estado</label>
            <select v-model="form.active" class="ui-select">
              <option :value="true">Activo</option>
              <option :value="false">Inactivo</option>
            </select>
          </div>
          <div class="sm:col-span-2">
            <div class="ui-subcard">
              <div class="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p class="text-sm font-semibold text-slate-800">Presentaciones y conversiones</p>
                  <p class="text-xs text-slate-400">
                    Unidad base: <span class="font-semibold text-indigo-600">{{ unitLabel(form.unit || 'unidad') }}</span>
                  </p>
                </div>
                <button type="button" class="ui-btn-secondary px-3 py-2" @click="addConversionRow">
                  Añadir presentación
                </button>
              </div>

              <div v-if="form.unit_conversions.length" class="mt-4 space-y-3">
                <div
                  v-for="(row, index) in form.unit_conversions"
                  :key="index"
                  class="grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:grid-cols-[1fr_180px_auto]"
                >
                  <div>
                    <label class="ui-label">Unidad comercial</label>
                    <select
                      v-model="row.unit_name"
                      class="ui-select"
                    >
                      <option value="">Seleccionar</option>
                      <option
                        v-for="option in conversionOptions(row.unit_name)"
                        :key="option.code"
                        :value="option.code"
                      >
                        {{ option.label }}
                      </option>
                    </select>
                  </div>
                  <div>
                    <label class="ui-label">Factor a base</label>
                    <input
                      v-model.number="row.factor_to_base"
                      class="ui-input"
                      type="number"
                      min="0.0001"
                      step="0.0001"
                    />
                  </div>
                  <div class="flex items-end">
                    <button type="button" class="ui-btn-secondary w-full px-3 py-2" @click="removeConversionRow(index)">
                      Quitar
                    </button>
                  </div>
                </div>
              </div>

              <p v-else class="mt-4 text-xs text-slate-400">
                Sin presentaciones adicionales. Ejemplo sugerido: <code>caja = 12</code>.
              </p>
            </div>
          </div>
        </div>

        <div class="mt-5 flex flex-wrap gap-3">
          <button class="ui-btn" :disabled="loading" @click="saveProduct">
            {{ loading ? 'Guardando...' : (isEditing ? 'Actualizar producto' : 'Guardar producto') }}
          </button>
          <button class="ui-btn-secondary" @click="resetForm">Limpiar formulario</button>
        </div>
      </article>

      <article class="ui-card">
        <h2 class="ui-heading">Importar desde Excel</h2>
        <p class="ui-subtitle">
          Soporta columnas como código, nombre, marca, tipo, unidad, costo y precio de venta.
        </p>

        <div class="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4">
          <label class="ui-label">Archivo .xlsx / .xls</label>
          <input class="ui-input" type="file" accept=".xlsx,.xls" @change="importFromExcel" />
          <p class="mt-2 text-xs text-slate-400">
            El sistema ignora etiquetas "nuevo" en SKU y genera código automático cuando falta.
          </p>
        </div>

        <div
          v-if="importMessage"
          class="mt-4"
          :class="importMessage.toLowerCase().includes('error') || importMessage.toLowerCase().includes('no se') ? 'ui-alert-error' : 'ui-alert'"
        >
          {{ importMessage }}
        </div>
      </article>
    </section>
  </div>
</template>
