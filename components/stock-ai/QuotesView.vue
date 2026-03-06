<script setup lang="ts">
type QuoteSummary = {
  id: string
  supplier_id: string
  supplier_name: string
  min_required_units: number
  status: string
  notes: string | null
  total_items: number
  total_units: number
  total_cost: number
  created_at: string
}

type UnitOption = {
  unit_name: string
  factor_to_base: number
}

type QuoteItem = {
  id: string
  product_id: string
  name: string
  brand: string | null
  sku: string | null
  category: string | null
  base_unit: string
  unit_name: string
  presentation_options: UnitOption[]
  qty: number
  suggested_qty: number
  cost_unit: number
  line_total: number
  stock_on_hand: number
}

type QuoteDetail = {
  id: string
  supplier_id: string
  supplier_name: string
  min_required_units: number
  status: string
  notes: string | null
  total_items: number
  total_units: number
  total_cost: number
  created_at: string
}

type OriginalState = {
  qty: number
  unit_name: string
}

type PendingUnitChange = {
  item_id: string
  item_name: string
  previous_unit: string
  next_unit: string
  previous_factor: number
  next_factor: number
  current_base_qty: number
  missing_base_qty: number
  adjusted_base_qty: number
  adjusted_presentation_qty: number
}

type BrandCheckMatch = {
  id: string
  sku: string | null
  name: string
  brand: string | null
  unit: string
  stock_on_hand: number
  avg_cost: number
  sale_price: number
  active: boolean
}

type BrandCheckResponse = {
  exists: boolean
  requested: {
    name: string
    brand: string | null
  }
  match: BrandCheckMatch | null
  matches_count: number
}

type BrandActionMode = 'append' | 'replace'

const quotes = ref<QuoteSummary[]>([])
const quoteSearch = ref('')
const selectedQuoteId = ref('')
const quoteDetail = ref<QuoteDetail | null>(null)
const quoteItems = ref<QuoteItem[]>([])
const loadingQuotes = ref(false)
const loadingDetail = ref(false)
const saving = ref(false)
const message = ref('')
const error = ref('')
const jsonModalOpen = ref(false)
const jsonCopied = ref(false)
const brandCheckModalOpen = ref(false)
const brandCheckMode = ref<'exists' | 'not_found'>('exists')
const brandCheckItemId = ref('')
const brandCheckProductName = ref('')
const brandCheckRequestedBrand = ref<string | null>(null)
const brandCheckMatch = ref<BrandCheckMatch | null>(null)
const brandCheckLoadingItemId = ref('')
const brandCreateLoading = ref(false)
const brandActionMode = ref<BrandActionMode>('append')
const brandDropdownItemId = ref('')
const brandDraftByItem = reactive<Record<string, string>>({})
const confirmUnitModalOpen = ref(false)
const pendingUnitChange = ref<PendingUnitChange | null>(null)
const originalByItem = reactive<Record<string, OriginalState>>({})

const numberFormatter = new Intl.NumberFormat('es-PE', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 3
})
const moneyFormatter = new Intl.NumberFormat('es-PE', {
  style: 'currency',
  currency: 'PEN',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
})

const formatUnits = (value: number) => numberFormatter.format(Number(value || 0))
const formatMoney = (value: number) => moneyFormatter.format(Number(value || 0))

const normalizeUnit = (value: unknown) =>
  String(value || '')
    .trim()
    .toLowerCase() || 'unidad'

const normalizeBrand = (value: unknown) => {
  const raw = String(value ?? '').trim()
  return raw ? raw : null
}

const toQty = (value: unknown, fallback = 1) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(0.001, Number(parsed.toFixed(3)))
}

const generatedAtLabel = (value: string) => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return new Intl.DateTimeFormat('es-PE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}

const factorForUnit = (item: QuoteItem, unitName: string) => {
  const unit = normalizeUnit(unitName)
  const option = (item.presentation_options || []).find((row) => normalizeUnit(row.unit_name) === unit)
  return option?.factor_to_base && option.factor_to_base > 0 ? Number(option.factor_to_base) : 1
}

const lineTotal = (item: QuoteItem) => {
  const factor = factorForUnit(item, item.unit_name)
  return Number((Number(item.qty || 0) * factor * Number(item.cost_unit || 0)).toFixed(2))
}

const quoteCode = (id: string) => String(id || '').slice(0, 8)

const filteredQuotes = computed(() => {
  const term = String(quoteSearch.value || '').trim().toLowerCase()
  if (!term) return quotes.value

  return quotes.value.filter((row) => {
    const haystack = `${row.supplier_name} ${quoteCode(row.id)} ${row.created_at}`.toLowerCase()
    return haystack.includes(term)
  })
})

const brandOptions = computed(() => {
  const map = new Map<string, string>()
  quoteItems.value.forEach((item) => {
    const brand = normalizeBrand(item.brand)
    if (!brand) return
    const key = brand.toLowerCase()
    if (!map.has(key)) map.set(key, brand)
  })
  return Array.from(map.values()).sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }))
})

const isBrandDropdownOpen = (itemId: string) => brandDropdownItemId.value === itemId

const brandDraftValue = (item: QuoteItem) => {
  const key = String(item.id || '')
  if (!Object.prototype.hasOwnProperty.call(brandDraftByItem, key)) {
    brandDraftByItem[key] = item.brand || ''
  }
  return String(brandDraftByItem[key] || '')
}

const filteredBrandOptionsForItem = (item: QuoteItem) => {
  const term = brandDraftValue(item)
    .trim()
    .toLowerCase()

  return brandOptions.value
    .filter((brand) => {
      if (!term) return true
      return brand.toLowerCase().includes(term)
    })
    .slice(0, 10)
}

const openBrandDropdown = (itemId: string) => {
  brandDropdownItemId.value = itemId
}

const toggleBrandDropdown = (itemId: string) => {
  brandDropdownItemId.value = brandDropdownItemId.value === itemId ? '' : itemId
}

const closeBrandDropdown = (itemId?: string) => {
  if (!itemId || brandDropdownItemId.value === itemId) {
    brandDropdownItemId.value = ''
  }
}

const hasChanges = computed(() =>
  quoteItems.value.some((item) => {
    const original = originalByItem[item.id]
    if (!original) return true
    const qtyChanged = Math.abs(Number(original.qty || 0) - Number(item.qty || 0)) > 0.0001
    const unitChanged = normalizeUnit(original.unit_name) !== normalizeUnit(item.unit_name)
    return qtyChanged || unitChanged
  })
)

const editedTotalCost = computed(() =>
  Number(quoteItems.value.reduce((sum, item) => sum + lineTotal(item), 0).toFixed(2))
)

const editedTotalUnits = computed(() =>
  quoteItems.value.reduce((sum, item) => {
    const factor = factorForUnit(item, item.unit_name)
    return sum + Number(item.qty || 0) * factor
  }, 0)
)

const editedTotalProducts = computed(() => quoteItems.value.length)

const brandMatchAlreadyInQuote = computed(() => {
  const matchId = String(brandCheckMatch.value?.id || '').trim()
  if (!matchId) return false
  const sourceItemId = String(brandCheckItemId.value || '')
  return quoteItems.value.some((item) => {
    const sameProduct = String(item.product_id || '').trim() === matchId
    if (!sameProduct) return false
    if (brandActionMode.value === 'append') return true
    return String(item.id || '') !== sourceItemId
  })
})

const brandActionLabel = computed(() =>
  brandActionMode.value === 'replace' ? 'cambio de marca' : 'agregado de marca'
)

const changedItemsPayload = computed(() =>
  quoteItems.value
    .filter((item) => {
      const original = originalByItem[item.id]
      if (!original) return true

      const qtyChanged = Math.abs(Number(original.qty || 0) - Number(item.qty || 0)) > 0.0001
      const unitChanged = normalizeUnit(original.unit_name) !== normalizeUnit(item.unit_name)
      return qtyChanged || unitChanged
    })
    .map((item) => ({
      id: item.id,
      qty: toQty(item.qty, 1),
      unit_name: normalizeUnit(item.unit_name)
    }))
)

const setItemQty = (item: QuoteItem) => {
  item.qty = toQty(item.qty, 1)
}

const onBrandInput = (item: QuoteItem, event: Event) => {
  const target = event.target as HTMLInputElement | null
  brandDraftByItem[item.id] = String(target?.value ?? '')
}

const onBrandBlur = (item: QuoteItem) => {
  window.setTimeout(() => {
    closeBrandDropdown(item.id)
  }, 110)
}

const onBrandEnter = (item: QuoteItem, event: KeyboardEvent) => {
  event.preventDefault()
  void onBrandCommit(item, 'append')
}

const closeBrandCheckModal = () => {
  brandCheckModalOpen.value = false
  brandCheckMatch.value = null
  brandCheckItemId.value = ''
  brandCheckProductName.value = ''
  brandCheckRequestedBrand.value = null
  brandCheckMode.value = 'exists'
  brandActionMode.value = 'append'
}

const verifyBrandForItem = async (item: QuoteItem, requestedBrand: string | null, actionMode: BrandActionMode) => {
  if (normalizeBrand(item.brand) === requestedBrand) return
  if (!String(item.name || '').trim()) return

  brandCheckLoadingItemId.value = item.id
  try {
    const result = await $fetch<BrandCheckResponse>('/api/products/verify-brand', {
      method: 'POST',
      body: {
        name: item.name,
        brand: requestedBrand,
        exclude_product_id: null
      }
    })

    brandCheckItemId.value = item.id
    brandCheckProductName.value = String(item.name || '')
    brandCheckRequestedBrand.value = requestedBrand
    brandActionMode.value = actionMode
    brandCheckMatch.value = result.match
    brandCheckMode.value = result.exists ? 'exists' : 'not_found'
    brandCheckModalOpen.value = true
  } catch (err: any) {
    error.value = err?.data?.statusMessage || err?.message || 'No se pudo verificar la marca del producto.'
  } finally {
    brandCheckLoadingItemId.value = ''
  }
}

const onBrandCommit = async (item: QuoteItem, actionMode: BrandActionMode) => {
  closeBrandDropdown(item.id)
  const requestedBrand = normalizeBrand(brandDraftValue(item))
  if (normalizeBrand(item.brand) === requestedBrand) {
    return
  }
  await verifyBrandForItem(item, requestedBrand, actionMode)
}

const selectBrandOption = (item: QuoteItem, brand: string | null) => {
  brandDraftByItem[item.id] = brand || ''
  closeBrandDropdown(item.id)
}

const addBrandVariantToQuote = async (productId: string, sourceItem: QuoteItem) => {
  const quoteId = String(selectedQuoteId.value || '')
  if (!quoteId) {
    throw new Error('Selecciona una cotización activa.')
  }

  await $fetch(`/api/suppliers/quotes/${quoteId}/items`, {
    method: 'POST',
    body: {
      product_id: productId,
      qty: toQty(sourceItem.qty, 1),
      suggested_qty: Number(sourceItem.suggested_qty || sourceItem.qty || 0),
      unit_name: normalizeUnit(sourceItem.unit_name),
      brand: brandCheckRequestedBrand.value,
      product_name: sourceItem.name,
      sku: brandCheckMatch.value?.sku || null
    }
  })
}

const removeQuoteItem = async (itemId: string) => {
  const quoteId = String(selectedQuoteId.value || '')
  if (!quoteId) {
    throw new Error('Selecciona una cotización activa.')
  }
  await $fetch(`/api/suppliers/quotes/${quoteId}/items/${itemId}`, {
    method: 'DELETE'
  })
}

const applyBrandActionWithProduct = async (targetProductId: string) => {
  const sourceItem = quoteItems.value.find((row) => row.id === brandCheckItemId.value)
  if (!sourceItem) {
    throw new Error('No se encontró el producto base para procesar la marca.')
  }

  const targetId = String(targetProductId || '').trim()
  if (!targetId) {
    throw new Error('Producto objetivo inválido.')
  }

  if (brandActionMode.value === 'append') {
    await addBrandVariantToQuote(targetId, sourceItem)
    return
  }

  if (String(sourceItem.product_id || '').trim() === targetId) {
    throw new Error('La marca seleccionada corresponde al mismo producto actual.')
  }

  if (quoteItems.value.some((row) => row.id !== sourceItem.id && String(row.product_id || '').trim() === targetId)) {
    throw new Error('La marca objetivo ya existe en esta cotización. Usa "Añadir marca" o ajusta la cantidad existente.')
  }

  await addBrandVariantToQuote(targetId, sourceItem)
  await removeQuoteItem(sourceItem.id)
}

const addMatchedProductToQuote = async () => {
  if (brandCheckMode.value !== 'exists' || !brandCheckMatch.value?.id) return
  brandCreateLoading.value = true
  error.value = ''
  try {
    await applyBrandActionWithProduct(String(brandCheckMatch.value.id))
    await loadQuoteDetail(String(selectedQuoteId.value || ''))
    message.value =
      brandActionMode.value === 'replace'
        ? `Marca cambiada: ${brandCheckProductName.value} (${brandCheckRequestedBrand.value || 'Sin marca'}).`
        : `Variante agregada: ${brandCheckProductName.value} (${brandCheckRequestedBrand.value || 'Sin marca'}).`
    closeBrandCheckModal()
  } catch (err: any) {
    error.value =
      err?.data?.statusMessage ||
      err?.message ||
      (brandActionMode.value === 'replace'
        ? 'No se pudo cambiar la marca en la cotización.'
        : 'No se pudo agregar la variante a la cotización.')
  } finally {
    brandCreateLoading.value = false
  }
}

const createProductWithBrand = async () => {
  if (brandCheckMode.value !== 'not_found') return
  const item = quoteItems.value.find((row) => row.id === brandCheckItemId.value)
  if (!item) {
    closeBrandCheckModal()
    return
  }

  brandCreateLoading.value = true
  error.value = ''
  try {
    const upsert = await $fetch<{ id: string }>('/api/products/catalog-upsert', {
      method: 'POST',
      body: {
        p_id: null,
        p_sku: null,
        p_name: item.name,
        p_unit: item.base_unit || 'unidad',
        p_brand: brandCheckRequestedBrand.value,
        p_category_name: item.category || null,
        p_barcode: null,
        p_active: true,
        p_sale_price: 0,
        p_min_stock: Number(quoteDetail.value?.min_required_units || 0),
        p_stock_on_hand: 0,
        p_avg_cost: Number(item.cost_unit || 0) > 0 ? Number(item.cost_unit || 0) : null,
        p_currency: 'PEN'
      }
    })

    await applyBrandActionWithProduct(String(upsert.id || ''))
    await loadQuoteDetail(String(selectedQuoteId.value || ''))
    message.value =
      brandActionMode.value === 'replace'
        ? `Producto creado y usado para reemplazo: ${item.name} (${brandCheckRequestedBrand.value || 'Sin marca'}).`
        : `Producto creado y agregado: ${item.name} (${brandCheckRequestedBrand.value || 'Sin marca'}).`
    closeBrandCheckModal()
  } catch (err: any) {
    error.value = err?.data?.statusMessage || err?.message || 'No se pudo crear/agregar el producto.'
  } finally {
    brandCreateLoading.value = false
  }
}

const closeUnitModal = () => {
  confirmUnitModalOpen.value = false
  pendingUnitChange.value = null
}

const confirmUnitModalBody = computed(() => {
  const pending = pendingUnitChange.value
  if (!pending) return ''

  return `Para cambiar "${pending.item_name}" a ${pending.next_unit}, necesitamos múltiplos de ${formatUnits(pending.next_factor)} unidades base. Actualmente tienes ${formatUnits(pending.current_base_qty)} unidades base; aumentaremos ${formatUnits(pending.missing_base_qty)} unidades para llegar a ${formatUnits(pending.adjusted_base_qty)} unidades base (${formatUnits(pending.adjusted_presentation_qty)} ${pending.next_unit}).`
})

const applyPendingUnitChange = () => {
  const pending = pendingUnitChange.value
  if (!pending) return

  const item = quoteItems.value.find((row) => row.id === pending.item_id)
  if (!item) {
    closeUnitModal()
    return
  }

  item.unit_name = pending.next_unit
  item.qty = toQty(pending.adjusted_presentation_qty, 1)
  closeUnitModal()
}

const setItemUnit = (item: QuoteItem, nextUnitRaw: string) => {
  const previousUnit = normalizeUnit(item.unit_name)
  const nextUnit = normalizeUnit(nextUnitRaw)
  if (previousUnit === nextUnit) return

  const previousFactor = factorForUnit(item, previousUnit)
  const nextFactor = factorForUnit(item, nextUnit)
  const currentBaseQty = Number((toQty(item.qty, 1) * previousFactor).toFixed(3))
  const exactNewQty = currentBaseQty / nextFactor

  if (nextFactor > 1) {
    const roundedPresentationQty = Math.ceil(exactNewQty - 1e-9)
    const adjustedBaseQty = Number((roundedPresentationQty * nextFactor).toFixed(3))
    const missingBaseQty = Number((adjustedBaseQty - currentBaseQty).toFixed(3))

    if (missingBaseQty > 0.0001) {
      pendingUnitChange.value = {
        item_id: item.id,
        item_name: item.name,
        previous_unit: previousUnit,
        next_unit: nextUnit,
        previous_factor: previousFactor,
        next_factor: nextFactor,
        current_base_qty: currentBaseQty,
        missing_base_qty: missingBaseQty,
        adjusted_base_qty: adjustedBaseQty,
        adjusted_presentation_qty: roundedPresentationQty
      }
      confirmUnitModalOpen.value = true
      return
    }
  }

  item.unit_name = nextUnit
  item.qty = toQty(exactNewQty, 1)
}

const onUnitChange = (item: QuoteItem, event: Event) => {
  const target = event.target as HTMLSelectElement | null
  setItemUnit(item, target?.value || item.unit_name)
}

const jsonPreview = computed(() => {
  const quote = quoteDetail.value
  const payload = {
    quote_id: String(quote?.id || ''),
    supplier_name: String(quote?.supplier_name || ''),
    created_at: String(quote?.created_at || ''),
    items: quoteItems.value.map((item) => ({
      id: String(item.id || ''),
      product_id: String(item.product_id || ''),
      sku: item.sku || null,
      name: String(item.name || ''),
      brand: normalizeBrand(item.brand),
      qty: Number(Number(item.qty || 0).toFixed(3)),
      unit_name: normalizeUnit(item.unit_name),
      cost_unit: Number(Number(item.cost_unit || 0).toFixed(4))
    }))
  }

  return JSON.stringify(payload, null, 2)
})

const openJsonModal = () => {
  error.value = ''
  message.value = ''
  jsonCopied.value = false

  if (!selectedQuoteId.value || !quoteItems.value.length) {
    error.value = 'Selecciona una cotización con productos para ver el JSON.'
    return
  }

  jsonModalOpen.value = true
}

const closeJsonModal = () => {
  jsonModalOpen.value = false
  jsonCopied.value = false
}

const copyJsonToClipboard = async () => {
  error.value = ''
  try {
    await navigator.clipboard.writeText(jsonPreview.value)
    jsonCopied.value = true
    message.value = 'JSON copiado al portapapeles.'
  } catch (err: any) {
    error.value = err?.message || 'No se pudo copiar el JSON.'
  }
}

const loadQuotes = async () => {
  loadingQuotes.value = true
  error.value = ''

  try {
    const data = await $fetch<{ quotes: QuoteSummary[] }>('/api/suppliers/quotes/page')
    quotes.value = data.quotes || []

    if (!selectedQuoteId.value && quotes.value.length) {
      selectedQuoteId.value = quotes.value[0].id
      await loadQuoteDetail(selectedQuoteId.value)
    }
  } catch (err: any) {
    error.value = err?.data?.statusMessage || err?.message || 'No se pudo cargar cotizaciones.'
  } finally {
    loadingQuotes.value = false
  }
}

const loadQuoteDetail = async (quoteId: string) => {
  if (!quoteId) return
  loadingDetail.value = true
  error.value = ''
  message.value = ''

  try {
    const data = await $fetch<{ quote: QuoteDetail; items: QuoteItem[] }>(`/api/suppliers/quotes/${quoteId}`)
    quoteDetail.value = data.quote
    quoteItems.value = (data.items || [])
      .map((item) => {
        const baseUnit = normalizeUnit((item as any)?.base_unit || 'unidad')
        const currentUnit = normalizeUnit(item.unit_name)
        const rawOptions = Array.isArray((item as any)?.presentation_options)
          ? (item as any).presentation_options
              .map((option: any) => ({
                unit_name: normalizeUnit(option?.unit_name),
                factor_to_base: Number(option?.factor_to_base || 1)
              }))
              .filter((option: UnitOption) => Number(option.factor_to_base || 0) > 0)
          : []

        const optionsMap = new Map<string, UnitOption>()
        optionsMap.set(baseUnit, { unit_name: baseUnit, factor_to_base: 1 })
        rawOptions.forEach((option: UnitOption) => {
          optionsMap.set(option.unit_name, option)
        })
        if (!optionsMap.has(currentUnit)) {
          optionsMap.set(currentUnit, { unit_name: currentUnit, factor_to_base: 1 })
        }

        return {
          ...item,
          base_unit: baseUnit,
          unit_name: currentUnit,
          presentation_options: Array.from(optionsMap.values()).sort((a, b) => a.factor_to_base - b.factor_to_base),
          qty: Number(item.qty || 0)
        }
      })
      .sort((a, b) => {
        const nameOrder = String(a.name || '').localeCompare(String(b.name || ''), 'es', { sensitivity: 'base' })
        if (nameOrder !== 0) return nameOrder
        return String(a.sku || '').localeCompare(String(b.sku || ''), 'es', { sensitivity: 'base' })
      })

    closeBrandDropdown()

    Object.keys(originalByItem).forEach((key) => {
      delete originalByItem[key]
    })
    Object.keys(brandDraftByItem).forEach((key) => {
      delete brandDraftByItem[key]
    })
    quoteItems.value.forEach((item) => {
      originalByItem[item.id] = {
        qty: Number(item.qty || 0),
        unit_name: normalizeUnit(item.unit_name)
      }
      brandDraftByItem[item.id] = item.brand || ''
    })
  } catch (err: any) {
    error.value = err?.data?.statusMessage || err?.message || 'No se pudo cargar el detalle.'
    quoteDetail.value = null
    quoteItems.value = []
  } finally {
    loadingDetail.value = false
  }
}

const saveChanges = async () => {
  error.value = ''
  message.value = ''

  if (!selectedQuoteId.value) {
    error.value = 'Selecciona una cotización.'
    return
  }
  if (!changedItemsPayload.value.length) {
    message.value = 'No hay cambios para guardar.'
    return
  }

  saving.value = true
  try {
    const result = await $fetch<{
      ok: boolean
      total_items: number
      total_units: number
      total_cost: number
    }>(`/api/suppliers/quotes/${selectedQuoteId.value}`, {
      method: 'PATCH',
      body: {
        items: changedItemsPayload.value
      }
    })

    quoteItems.value.forEach((item) => {
      originalByItem[item.id] = {
        qty: Number(item.qty || 0),
        unit_name: normalizeUnit(item.unit_name)
      }
    })

    if (quoteDetail.value) {
      quoteDetail.value.total_items = Number(result.total_items || 0)
      quoteDetail.value.total_units = Number(result.total_units || 0)
      quoteDetail.value.total_cost = Number(result.total_cost || 0)
    }

    quotes.value = quotes.value.map((row) =>
      row.id === selectedQuoteId.value
        ? {
            ...row,
            total_items: Number(result.total_items || row.total_items),
            total_units: Number(result.total_units || row.total_units),
            total_cost: Number(result.total_cost || row.total_cost)
          }
        : row
    )

    message.value = 'Cotización actualizada correctamente.'
  } catch (err: any) {
    error.value = err?.data?.statusMessage || err?.message || 'No se pudo guardar cambios.'
  } finally {
    saving.value = false
  }
}

const selectQuote = async (quoteId: string) => {
  if (!quoteId || quoteId === selectedQuoteId.value) return
  selectedQuoteId.value = quoteId
  await loadQuoteDetail(quoteId)
}

const escapeHtml = (value: unknown) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')

const printProductsList = () => {
  if (!quoteDetail.value || !quoteItems.value.length) {
    error.value = 'No hay productos para imprimir.'
    return
  }

  const rows = quoteItems.value
    .map((item, index) => {
      const brand = item.brand || 'Sin marca'
      const unitFactor = factorForUnit(item, item.unit_name)
      const unitLabel = `${item.unit_name} (x${formatUnits(unitFactor)})`
      return `
        <tr>
          <td>${escapeHtml(index + 1)}</td>
          <td>${escapeHtml(item.name)}</td>
          <td>${escapeHtml(brand)}</td>
          <td>${escapeHtml(formatUnits(item.qty))}</td>
          <td>${escapeHtml(unitLabel)}</td>
        </tr>
      `
    })
    .join('')

  const html = `
    <html>
      <head>
        <meta charset="utf-8" />
        <title>Listado de productos</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            padding: 24px;
            color: #0f172a;
          }
          h1 {
            margin: 0 0 10px;
            font-size: 22px;
          }
          p {
            margin: 0 0 6px;
            color: #334155;
            font-size: 13px;
          }
          table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 14px;
            font-size: 12px;
          }
          th, td {
            border: 1px solid #cbd5e1;
            padding: 8px;
            text-align: left;
          }
          th {
            background: #f1f5f9;
            font-weight: 700;
          }
        </style>
      </head>
      <body>
        <h1>Listado de productos</h1>

        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Producto</th>
              <th>Marca</th>
              <th>Cantidad</th>
              <th>Unidad</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </body>
    </html>
  `

  const printWindow = window.open('', '_blank', 'width=1200,height=900')
  if (!printWindow) {
    error.value = 'No se pudo abrir la ventana de impresion.'
    return
  }

  printWindow.document.open()
  printWindow.document.write(html)
  printWindow.document.close()
  printWindow.focus()
  printWindow.print()
}

onMounted(loadQuotes)
</script>

<template>
  <div class="space-y-6 pb-20 xl:pb-8">
    <section class="ui-card space-y-4">
      <input
        v-model="quoteSearch"
        type="text"
        class="ui-input"
        placeholder="Buscar cotización por proveedor o fecha..."
      />

      <div v-if="error" class="ui-alert-error">{{ error }}</div>
      <div v-else-if="message" class="ui-alert">{{ message }}</div>

      <div v-if="!filteredQuotes.length && !loadingQuotes" class="ui-empty-state mt-4">
        No hay cotizaciones que coincidan con la búsqueda.
      </div>

      <div v-else class="ui-table-wrap mt-4 max-h-[40vh] overflow-auto">
        <table class="ui-table">
          <thead>
            <tr>
              <th>Proveedor</th>
              <th>Fecha</th>
              <th>Items</th>
              <th>Total</th>
              <th>Acción</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="quote in filteredQuotes"
              :key="quote.id"
              :class="selectedQuoteId === quote.id ? 'bg-indigo-50/60' : ''"
            >
              <td class="font-semibold text-slate-800">{{ quote.supplier_name }}</td>
              <td class="text-slate-600">{{ generatedAtLabel(quote.created_at) }}</td>
              <td class="font-semibold text-slate-700">{{ formatUnits(quote.total_items) }}</td>
              <td class="font-semibold text-slate-800">
                {{
                  selectedQuoteId === quote.id
                    ? formatMoney(editedTotalCost)
                    : formatMoney(quote.total_cost)
                }}
              </td>
              <td>
                <button class="ui-btn-secondary px-3 py-2 text-xs" @click="selectQuote(quote.id)">
                  {{ selectedQuoteId === quote.id ? 'Abierta' : 'Ver' }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="ui-card">
      <div v-if="loadingDetail" class="ui-empty-state">Cargando detalle...</div>

      <div v-else-if="!quoteDetail" class="ui-empty-state">
        Selecciona una cotización para ver el detalle.
      </div>

      <template v-else>
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 class="text-xl font-extrabold text-slate-800">{{ quoteDetail.supplier_name }}</h3>
            <p class="mt-1 text-sm text-slate-500">
              Fecha: {{ generatedAtLabel(quoteDetail.created_at) }} · Mínimo base: {{ formatUnits(quoteDetail.min_required_units) }} u.
            </p>
            <p v-if="quoteDetail.notes" class="mt-1 text-sm text-slate-500">
              Nota: {{ quoteDetail.notes }}
            </p>
          </div>

          <div class="rounded-xl border border-indigo-100 bg-indigo-50 px-4 py-3 text-right">
            <p class="text-xs font-semibold uppercase tracking-wide text-indigo-600">Total editable</p>
            <p class="mt-1 text-xl font-extrabold text-indigo-700">{{ formatMoney(editedTotalCost) }}</p>
            <p class="mt-1 text-xs text-indigo-600">{{ formatUnits(editedTotalProducts) }} productos</p>
          </div>
        </div>

        <div class="mt-4 flex flex-wrap items-center justify-end gap-2">
          <button class="ui-btn-secondary px-4 py-2 text-xs" @click="openJsonModal">
            JSON
          </button>
          <button class="ui-btn-secondary px-4 py-2 text-xs" @click="printProductsList">
            Imprimir listado
          </button>
          <button class="ui-btn-secondary px-4 py-2 text-xs" :disabled="saving || !hasChanges" @click="saveChanges">
            {{ saving ? 'Guardando cambios...' : 'Guardar cambios' }}
          </button>
        </div>

        <div class="ui-table-wrap mt-4 max-h-[60vh] overflow-auto">
          <table class="ui-table">
            <thead>
              <tr>
                <th>Producto</th>
                <th>Marca</th>
                <th>Stock actual</th>
                <th>Cantidad</th>
                <th>Unidad</th>
                <th>Costo unitario</th>
                <th>Inversión</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in quoteItems" :key="item.id">
                <td>
                  <p class="font-semibold text-slate-800">{{ item.name }}</p>
                  <p class="mt-1 text-xs text-slate-400">{{ item.category || 'Sin categoría' }}</p>
                </td>
                <td>
                  <p class="text-xs font-semibold uppercase tracking-wide text-slate-400">
                    Actual: {{ item.brand || 'Sin marca' }}
                  </p>
                  <div class="relative mt-1 min-w-[190px]">
                    <input
                      :value="brandDraftValue(item)"
                      type="text"
                      class="ui-input w-full min-w-[170px] pr-10"
                      placeholder="Añadir otra marca..."
                      @focus="openBrandDropdown(item.id)"
                      @input="onBrandInput(item, $event); openBrandDropdown(item.id)"
                      @blur="onBrandBlur(item)"
                      @keydown.enter="onBrandEnter(item, $event)"
                    />
                    <button
                      type="button"
                      class="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-slate-400 transition hover:text-indigo-600"
                      @mousedown.prevent
                      @click="toggleBrandDropdown(item.id)"
                    >
                      <svg viewBox="0 0 20 20" fill="none" class="h-4 w-4">
                        <path
                          d="M5.75 7.75 10 12l4.25-4.25"
                          stroke="currentColor"
                          stroke-width="1.8"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        />
                      </svg>
                    </button>

                    <div
                      v-if="isBrandDropdownOpen(item.id)"
                      class="absolute left-0 right-0 z-20 mt-1 max-h-52 overflow-auto rounded-xl border border-slate-200 bg-white p-1 shadow-xl"
                    >
                      <button
                        type="button"
                        class="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-50"
                        @mousedown.prevent
                        @click="selectBrandOption(item, null)"
                      >
                        <span>Sin marca</span>
                        <span class="text-xs text-slate-400">null</span>
                      </button>
                      <button
                        v-for="brand in filteredBrandOptionsForItem(item)"
                        :key="`${item.id}-brand-${brand}`"
                        type="button"
                        class="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-indigo-50"
                        @mousedown.prevent
                        @click="selectBrandOption(item, brand)"
                      >
                        <span class="truncate">{{ brand }}</span>
                        <span v-if="normalizeBrand(item.brand) === normalizeBrand(brand)" class="text-xs font-semibold text-indigo-600">
                          actual
                        </span>
                      </button>
                      <p v-if="!filteredBrandOptionsForItem(item).length" class="px-3 py-2 text-xs text-slate-400">
                        No hay marcas coincidentes. Escribe la marca y haz Enter o clic en "Añadir marca".
                      </p>
                    </div>
                  </div>
                  <div class="mt-1 flex items-center gap-2">
                    <button
                      type="button"
                      class="ui-btn-secondary px-2 py-1 text-[11px]"
                      :disabled="
                        brandCheckLoadingItemId === item.id ||
                        normalizeBrand(brandDraftValue(item)) === normalizeBrand(item.brand)
                      "
                      @click="onBrandCommit(item, 'replace')"
                    >
                      Cambiar marca
                    </button>
                    <button
                      type="button"
                      class="ui-btn-secondary px-2 py-1 text-[11px]"
                      :disabled="
                        brandCheckLoadingItemId === item.id ||
                        normalizeBrand(brandDraftValue(item)) === normalizeBrand(item.brand)
                      "
                      @click="onBrandCommit(item, 'append')"
                    >
                      Añadir marca
                    </button>
                    <p v-if="brandCheckLoadingItemId === item.id" class="text-[11px] font-semibold text-indigo-600">
                      Verificando marca...
                    </p>
                  </div>
                </td>
                <td class="font-semibold text-slate-700">{{ formatUnits(item.stock_on_hand) }}</td>
                <td>
                  <input
                    v-model.number="item.qty"
                    type="number"
                    min="0.001"
                    step="0.001"
                    class="ui-input max-w-[140px]"
                    @input="setItemQty(item)"
                    @change="setItemQty(item)"
                  />
                </td>
                <td>
                  <select
                    :value="item.unit_name"
                    class="ui-select min-w-[160px]"
                    @change="onUnitChange(item, $event)"
                  >
                    <option
                      v-for="option in item.presentation_options"
                      :key="`${item.id}-${option.unit_name}`"
                      :value="option.unit_name"
                    >
                      {{ option.unit_name }} (x{{ formatUnits(option.factor_to_base) }})
                    </option>
                  </select>
                </td>
                <td class="font-semibold text-slate-700">{{ formatMoney(item.cost_unit) }}</td>
                <td class="font-semibold text-slate-800">{{ formatMoney(lineTotal(item)) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </section>

    <transition
      enter-active-class="transition duration-200"
      enter-from-class="opacity-0 scale-95"
      enter-to-class="opacity-100 scale-100"
      leave-active-class="transition duration-150"
      leave-from-class="opacity-100 scale-100"
      leave-to-class="opacity-0 scale-95"
    >
      <div v-if="jsonModalOpen" class="fixed inset-0 z-[95]">
        <button class="absolute inset-0 bg-slate-900/55" aria-label="Cerrar modal JSON" @click="closeJsonModal" />

        <div class="absolute inset-0 overflow-y-auto p-4 sm:p-6" @click.stop>
          <article class="mx-auto my-2 w-full max-w-4xl sm:my-8">
            <div class="rounded-[20px] bg-gradient-to-br from-indigo-500 via-indigo-600 to-sky-500 p-[1px] shadow-2xl">
              <div class="rounded-[19px] border border-white/40 bg-white p-5 sm:p-6">
                <div class="flex items-center justify-between gap-3">
                  <div>
                    <p class="text-xs font-extrabold uppercase tracking-[0.16em] text-indigo-500">Export JSON</p>
                    <h3 class="mt-1 text-xl font-extrabold text-slate-800">Listado de productos</h3>
                  </div>
                  <button class="ui-btn-secondary px-3 py-2 text-xs" @click="closeJsonModal">Cerrar</button>
                </div>

                <div class="mt-4 rounded-xl border border-slate-200 bg-slate-950 p-3">
                  <pre class="max-h-[52vh] overflow-auto text-xs leading-relaxed text-slate-100">{{ jsonPreview }}</pre>
                </div>

                <div class="mt-4 flex justify-end gap-2">
                  <button class="ui-btn-secondary" @click="closeJsonModal">Cancelar</button>
                  <button class="ui-btn min-w-[170px]" @click="copyJsonToClipboard">
                    {{ jsonCopied ? 'Copiado' : 'Copiar JSON' }}
                  </button>
                </div>
              </div>
            </div>
          </article>
        </div>
      </div>
    </transition>

    <transition
      enter-active-class="transition duration-200"
      enter-from-class="opacity-0 scale-95"
      enter-to-class="opacity-100 scale-100"
      leave-active-class="transition duration-150"
      leave-from-class="opacity-100 scale-100"
      leave-to-class="opacity-0 scale-95"
    >
      <div v-if="brandCheckModalOpen" class="fixed inset-0 z-[96]">
        <button class="absolute inset-0 bg-slate-900/55" aria-label="Cerrar modal marca" @click="closeBrandCheckModal" />

        <div class="absolute inset-0 overflow-y-auto p-4 sm:p-6" @click.stop>
          <article class="mx-auto my-2 w-full max-w-2xl sm:my-8">
            <div class="rounded-[20px] bg-gradient-to-br from-indigo-500 via-indigo-600 to-sky-500 p-[1px] shadow-2xl">
              <div class="rounded-[19px] border border-white/40 bg-white p-5 sm:p-6">
                <p class="text-xs font-extrabold uppercase tracking-[0.16em] text-indigo-500">Validación de marca</p>
                <h3 class="mt-2 text-xl font-extrabold text-slate-800">
                  {{ brandCheckMode === 'exists' ? 'Producto encontrado' : 'Producto no encontrado' }}
                </h3>
                <p class="mt-2 text-sm text-slate-600">
                  Flujo: <strong class="capitalize">{{ brandActionLabel }}</strong> ·
                  Producto: <strong>{{ brandCheckProductName }}</strong> · Marca:
                  <strong>{{ brandCheckRequestedBrand || 'Sin marca' }}</strong>
                </p>

                <div v-if="brandCheckMode === 'exists' && brandCheckMatch" class="mt-4 rounded-xl border border-emerald-100 bg-emerald-50 p-4">
                  <p class="text-sm font-semibold text-emerald-700">
                    {{
                      brandActionMode === 'replace'
                        ? 'Sí existe un producto con esta marca. ¿Deseas reemplazar el producto actual en la cotización?'
                        : 'Sí existe un producto con esta marca. ¿Deseas agregar esta variante a la cotización?'
                    }}
                  </p>
                  <p class="mt-2 text-xs text-emerald-700">
                    ID: {{ brandCheckMatch.id }} · SKU: {{ brandCheckMatch.sku || '-' }} · Unidad: {{ brandCheckMatch.unit }}
                  </p>
                  <p class="mt-1 text-xs text-emerald-700">
                    Stock: {{ formatUnits(brandCheckMatch.stock_on_hand) }} · Costo prom: {{ formatMoney(brandCheckMatch.avg_cost) }}
                  </p>
                  <p v-if="brandMatchAlreadyInQuote" class="mt-2 text-xs font-semibold text-emerald-700">
                    {{
                      brandActionMode === 'replace'
                        ? 'La marca objetivo ya existe en la cotización actual.'
                        : 'Esta variante ya está agregada en la cotización actual.'
                    }}
                  </p>
                </div>

                <div v-else class="mt-4 rounded-xl border border-amber-100 bg-amber-50 p-4">
                  <p class="text-sm font-semibold text-amber-700">
                    No existe un producto con este nombre y marca.
                  </p>
                  <p class="mt-2 text-xs text-amber-700">
                    {{
                      brandActionMode === 'replace'
                        ? '¿Deseas crearlo y usarlo para reemplazar el producto actual?'
                        : '¿Deseas crearlo y agregarlo a la cotización?'
                    }}
                  </p>
                </div>

                <div class="mt-5 flex justify-end gap-2">
                  <button class="ui-btn-secondary" @click="closeBrandCheckModal">Cerrar</button>
                  <button
                    v-if="brandCheckMode === 'exists'"
                    class="ui-btn min-w-[190px]"
                    :disabled="brandCreateLoading || brandMatchAlreadyInQuote"
                    @click="addMatchedProductToQuote"
                  >
                    {{
                      brandMatchAlreadyInQuote
                        ? 'Ya agregado'
                        : brandCreateLoading
                          ? 'Agregando...'
                          : brandActionMode === 'replace'
                            ? 'Reemplazar en cotización'
                            : 'Agregar a cotización'
                    }}
                  </button>
                  <button
                    v-if="brandCheckMode === 'not_found'"
                    class="ui-btn min-w-[190px]"
                    :disabled="brandCreateLoading"
                    @click="createProductWithBrand"
                  >
                    {{
                      brandCreateLoading
                        ? 'Creando...'
                        : brandActionMode === 'replace'
                          ? 'Crear y reemplazar'
                          : 'Crear y agregar'
                    }}
                  </button>
                </div>
              </div>
            </div>
          </article>
        </div>
      </div>
    </transition>

    <transition
      enter-active-class="transition duration-200"
      enter-from-class="opacity-0 scale-95"
      enter-to-class="opacity-100 scale-100"
      leave-active-class="transition duration-150"
      leave-from-class="opacity-100 scale-100"
      leave-to-class="opacity-0 scale-95"
    >
      <div v-if="confirmUnitModalOpen" class="fixed inset-0 z-[90]">
        <button class="absolute inset-0 bg-slate-900/55" aria-label="Cerrar modal" @click="closeUnitModal" />

        <div class="absolute inset-0 overflow-y-auto p-4 sm:p-6" @click.stop>
          <article class="mx-auto my-2 w-full max-w-2xl sm:my-8">
            <div class="rounded-[20px] bg-gradient-to-br from-indigo-500 via-indigo-600 to-sky-500 p-[1px] shadow-2xl">
              <div class="rounded-[19px] border border-white/40 bg-white p-5 sm:p-6">
                <p class="text-xs font-extrabold uppercase tracking-[0.16em] text-indigo-500">Ajuste de presentación</p>
                <h3 class="mt-2 text-xl font-extrabold text-slate-800">Confirmar redondeo de cantidad</h3>
                <p class="mt-3 text-sm leading-relaxed text-slate-600">
                  {{ confirmUnitModalBody }}
                </p>

                <div v-if="pendingUnitChange" class="mt-4 grid gap-2 sm:grid-cols-3">
                  <div class="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2">
                    <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Cantidad actual</p>
                    <p class="mt-1 text-lg font-extrabold text-slate-800">
                      {{ formatUnits(pendingUnitChange.current_base_qty) }} u.
                    </p>
                  </div>
                  <div class="rounded-xl border border-amber-100 bg-amber-50 px-3 py-2">
                    <p class="text-[11px] font-semibold uppercase tracking-wide text-amber-600">Aumento requerido</p>
                    <p class="mt-1 text-lg font-extrabold text-amber-700">
                      +{{ formatUnits(pendingUnitChange.missing_base_qty) }} u.
                    </p>
                  </div>
                  <div class="rounded-xl border border-indigo-100 bg-indigo-50 px-3 py-2">
                    <p class="text-[11px] font-semibold uppercase tracking-wide text-indigo-600">Nuevo total</p>
                    <p class="mt-1 text-lg font-extrabold text-indigo-700">
                      {{ formatUnits(pendingUnitChange.adjusted_presentation_qty) }} {{ pendingUnitChange.next_unit }}
                    </p>
                  </div>
                </div>

                <div class="mt-5 flex justify-end gap-2">
                  <button class="ui-btn-secondary" @click="closeUnitModal">Cancelar</button>
                  <button class="ui-btn min-w-[190px]" @click="applyPendingUnitChange">
                    Confirmar ajuste
                  </button>
                </div>
              </div>
            </div>
          </article>
        </div>
      </div>
    </transition>
  </div>
</template>
