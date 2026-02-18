<script setup lang="ts">
const HIGH_DIFF_THRESHOLD = 5
const CUSTOM_REASON = '__custom__'
const REASON_PRESETS = [
  'Diferencia por conteo físico',
  'Merma por producto dañado',
  'Producto vencido/no vendible',
  'Pérdida o extravío',
  'Error de registro anterior',
  'Ajuste por unidad/empaque'
]

const products = ref<any[]>([])
const query = ref('')
const onlyLowStock = ref(false)
const onlyChanges = ref(false)
const message = ref('')
const loading = ref(false)
const saving = ref(false)
const closingSession = ref(false)
const exportingSession = ref(false)

const session = ref<any | null>(null)
const sessionItems = ref<any[]>([])
const sessionNotes = ref('')
const closedSummary = ref<any | null>(null)

const drafts = reactive<Record<string, {
  counted: number
  damaged: number
  prevDamaged: number
  deactivate: boolean
  reason: string
  reasonSelection: string
  customReason: string
  reconfirm: boolean
  touched: boolean
}>>({})

const normalizeNumber = (value: any) => {
  const num = Number(value)
  return Number.isFinite(num) ? num : 0
}

const normalizeUnits = (value: any) => {
  const num = Number(value)
  if (!Number.isFinite(num)) return 0
  return Math.max(0, Math.trunc(num))
}

const normalizeSignedUnits = (value: any) => {
  const num = Number(value)
  if (!Number.isFinite(num)) return 0
  return Math.trunc(num)
}

const formatMoney = (value: number) => `S/ ${Number(value || 0).toFixed(2)}`
const formatDateTime = (value: string) => new Date(value).toLocaleString()

const getErrorMessage = (err: any, fallback: string) =>
  err?.data?.statusMessage || err?.message || fallback

const getSessionItem = (productId: string) =>
  sessionItems.value.find((item) => item.product_id === productId)

const isPresetReason = (reason: string) => REASON_PRESETS.includes(reason)

const resetDraft = (product: any) => {
  const sessionItem = getSessionItem(product.id)
  const counted = sessionItem ? normalizeUnits(sessionItem.stock_final) : normalizeUnits(product.stock_on_hand)
  const damaged = sessionItem ? normalizeUnits(sessionItem.non_sellable) : 0
  const savedReason = String(sessionItem?.reason || '').trim()
  const reasonSelection = savedReason
    ? (isPresetReason(savedReason) ? savedReason : CUSTOM_REASON)
    : ''
  const customReason = reasonSelection === CUSTOM_REASON ? savedReason : ''

  drafts[product.id] = {
    counted,
    damaged,
    prevDamaged: damaged,
    deactivate: product.active === false,
    reason: savedReason,
    reasonSelection,
    customReason,
    reconfirm: sessionItem?.reconfirmed || false,
    touched: false
  }
}

const getDraft = (product: any) => {
  if (!drafts[product.id]) {
    resetDraft(product)
  }
  return drafts[product.id]
}

const markTouched = (product: any) => {
  const draft = getDraft(product)
  draft.touched = true
}

const syncReason = (product: any) => {
  const draft = getDraft(product)

  if (draft.reasonSelection === CUSTOM_REASON) {
    draft.reason = String(draft.customReason || '')
  } else {
    draft.reason = String(draft.reasonSelection || '')
    draft.customReason = ''
  }

  draft.touched = true
}

const sanitizeDraftUnits = (product: any, field: 'counted' | 'damaged') => {
  const draft = getDraft(product)
  draft[field] = normalizeUnits(draft[field])
  draft.touched = true
}

const applyDamagedChange = (product: any) => {
  const draft = getDraft(product)
  const previousDamaged = normalizeUnits(draft.prevDamaged)
  const totalBase = normalizeUnits(draft.counted) + previousDamaged
  const newDamaged = Math.min(normalizeUnits(draft.damaged), totalBase)
  const newCounted = totalBase - newDamaged

  draft.damaged = newDamaged
  draft.counted = newCounted
  draft.prevDamaged = newDamaged
  draft.touched = true
}

const systemStock = (product: any) => normalizeUnits(product.stock_on_hand)
const countedStock = (product: any) => normalizeUnits(getDraft(product).counted)
const nonSellableStock = (product: any) => normalizeUnits(getDraft(product).damaged)
const finalSellableStock = (product: any) => countedStock(product)
const stockDelta = (product: any) => finalSellableStock(product) - systemStock(product)

const requiresReconfirm = (product: any) => Math.abs(stockDelta(product)) >= HIGH_DIFF_THRESHOLD

const hasRowChanges = (product: any) => {
  const draft = getDraft(product)
  const changedStock = stockDelta(product) !== 0
  const changedActive = draft.deactivate !== (product.active === false)
  return draft.touched && (changedStock || changedActive)
}

const changedProducts = computed(() => products.value.filter((product) => hasRowChanges(product)))

const summary = computed(() => {
  const stockUnits = products.value.reduce((sum, p) => sum + systemStock(p), 0)
  const stockValue = products.value.reduce(
    (sum, p) => sum + systemStock(p) * normalizeNumber(p.avg_cost),
    0
  )
  const lowStock = products.value.filter(
    (p) => systemStock(p) <= normalizeUnits(p.min_stock)
  ).length

  return {
    stockUnits,
    stockValue,
    lowStock,
    changedRows: changedProducts.value.length,
    needsReconfirm: changedProducts.value.filter((p) => requiresReconfirm(p) && !getDraft(p).reconfirm).length
  }
})

const filteredProducts = computed(() => {
  const term = query.value.toLowerCase().trim()

  return products.value.filter((product) => {
    const isLow = systemStock(product) <= normalizeUnits(product.min_stock)
    if (onlyLowStock.value && !isLow) return false
    if (onlyChanges.value && !hasRowChanges(product)) return false

    if (!term) return true
    return `${product.name || ''} ${product.sku || ''}`.toLowerCase().includes(term)
  })
})

const sessionSummary = computed(() => {
  const applied = sessionItems.value.filter((item) => item.applied)

  const positiveUnits = applied.reduce(
    (sum, item) => sum + Math.max(0, normalizeSignedUnits(item.delta_qty)),
    0
  )
  const negativeUnits = applied.reduce(
    (sum, item) => sum + Math.max(0, -normalizeSignedUnits(item.delta_qty)),
    0
  )
  const nonSellable = applied.reduce(
    (sum, item) => sum + normalizeUnits(item.non_sellable),
    0
  )

  const positiveValue = applied.reduce(
    (sum, item) => sum + Math.max(0, normalizeNumber(item.delta_qty)) * normalizeNumber(item.avg_cost),
    0
  )
  const negativeValue = applied.reduce(
    (sum, item) => sum + Math.max(0, -normalizeNumber(item.delta_qty)) * normalizeNumber(item.avg_cost),
    0
  )

  return {
    adjustedItems: applied.length,
    positiveUnits,
    negativeUnits,
    nonSellable,
    positiveValue,
    negativeValue,
    netUnits: positiveUnits - negativeUnits,
    netValue: positiveValue - negativeValue
  }
})

const loadInventory = async (options?: { keepMessage?: boolean }) => {
  loading.value = true
  if (!options?.keepMessage) message.value = ''

  try {
    const res = await $fetch('/api/inventory/page')
    products.value = (res as any)?.products || []
    session.value = (res as any)?.session || null
    sessionItems.value = (res as any)?.sessionItems || []
    sessionNotes.value = session.value?.notes || ''

    products.value.forEach((product) => resetDraft(product))
  } catch (err: any) {
    message.value = getErrorMessage(err, 'No se pudo cargar el inventario.')
  } finally {
    loading.value = false
  }
}

const startSession = async () => {
  if (session.value) {
    message.value = `Ya existe una sesión abierta: ${session.value.code}`
    return
  }

  message.value = ''

  try {
    const res = await $fetch('/api/inventory/start', {
      method: 'POST',
      body: {
        notes: String(sessionNotes.value || '').trim() || null
      }
    })

    await loadInventory({ keepMessage: true })
    message.value = (res as any)?.alreadyOpen
      ? `Ya existe una sesión abierta: ${(res as any)?.session?.code}`
      : `Sesión iniciada: ${(res as any)?.session?.code}`
  } catch (err: any) {
    message.value = getErrorMessage(err, 'No se pudo iniciar la sesión.')
  }
}

const applyAdjustment = async (product: any, silent = false) => {
  try {
    if (!session.value) {
      message.value = 'Primero inicia una sesión de conteo.'
      return
    }

    const draft = getDraft(product)
    const newStock = normalizeUnits(finalSellableStock(product))
    const delta = stockDelta(product)
    const activeChange = draft.deactivate !== (product.active === false)
    const reasonText = String(draft.reason || '').trim()

    if (delta === 0 && !activeChange) {
      if (!silent) message.value = `Sin cambios para ${product.name}`
      return
    }

    if (!reasonText) {
      message.value = `Debes ingresar motivo del ajuste para ${product.name}.`
      return
    }

    if (requiresReconfirm(product) && !draft.reconfirm) {
      message.value = `Confirma reconteo para ${product.name} (ajuste >= ${HIGH_DIFF_THRESHOLD} unidades).`
      return
    }

    const res = await $fetch('/api/inventory/apply', {
      method: 'POST',
      body: {
        session_id: session.value.id,
        product_id: product.id,
        stock_final: newStock,
        non_sellable: nonSellableStock(product),
        reason: reasonText,
        reconfirmed: requiresReconfirm(product) ? draft.reconfirm : false,
        active: !draft.deactivate
      }
    })

    if ((res as any)?.changed && (res as any)?.item) {
      const item = (res as any).item
      const index = sessionItems.value.findIndex((entry) => entry.product_id === product.id)
      if (index >= 0) {
        sessionItems.value[index] = item
      } else {
        sessionItems.value.unshift(item)
      }
    }

    product.stock_on_hand = newStock
    product.active = !draft.deactivate
    resetDraft(product)

    if (!silent) {
      message.value = `Ajuste aplicado: ${product.name}`
    }
  } catch (err: any) {
    if (!silent) {
      message.value = err?.message || `No se pudo aplicar ajuste en ${product.name}.`
    }
    throw err
  }
}

const applySelectedAdjustments = async () => {
  if (!session.value) {
    message.value = 'Primero inicia una sesión de conteo.'
    return
  }

  const targets = changedProducts.value
  if (!targets.length) {
    message.value = 'No hay cambios pendientes por aplicar.'
    return
  }

  if (summary.value.needsReconfirm > 0) {
    message.value = `Hay ${summary.value.needsReconfirm} productos que requieren reconteo confirmado.`
    return
  }

  saving.value = true
  message.value = ''
  let applied = 0

  try {
    for (const product of targets) {
      await applyAdjustment(product, true)
      applied += 1
    }

    message.value = `Ajustes aplicados correctamente (${applied} productos).`
  } catch (err: any) {
    message.value = err?.message || 'No se pudieron aplicar los ajustes.'
  } finally {
    saving.value = false
  }
}

const resetAllDrafts = () => {
  products.value.forEach((product) => resetDraft(product))
  message.value = 'Cambios locales reiniciados.'
}

const closeSession = async () => {
  if (!session.value) {
    message.value = 'No hay sesión abierta.'
    return
  }

  if (summary.value.changedRows > 0) {
    message.value = 'Aún hay cambios pendientes. Aplica o reinicia antes de cerrar la sesión.'
    return
  }

  closingSession.value = true

  try {
    const res = await $fetch('/api/inventory/close', {
      method: 'POST',
      body: {
        session_id: session.value.id,
        notes: String(sessionNotes.value || '').trim() || null
      }
    })

    closedSummary.value = {
      code: session.value.code,
      closedAt: (res as any)?.closedAt || new Date().toISOString(),
      ...sessionSummary.value
    }

    session.value = null
    sessionItems.value = []
    products.value.forEach((product) => resetDraft(product))
    message.value = 'Sesión cerrada correctamente.'
  } catch (err: any) {
    message.value = err?.message || 'No se pudo cerrar la sesión.'
  } finally {
    closingSession.value = false
  }
}

const exportSessionReport = async () => {
  if (!session.value || !sessionItems.value.length) {
    message.value = 'No hay datos de sesión para exportar.'
    return
  }

  exportingSession.value = true

  try {
    const rows = sessionItems.value.map((item) => {
      const product = products.value.find((p) => p.id === item.product_id)
      return {
        session_code: session.value.code,
        product_sku: product?.sku || '',
        product_name: product?.name || '',
        stock_system: normalizeUnits(item.stock_system),
        contado: normalizeUnits(item.counted),
        no_vendible: normalizeUnits(item.non_sellable),
        stock_final: normalizeUnits(item.stock_final),
        ajuste: normalizeSignedUnits(item.delta_qty),
        costo_promedio: normalizeNumber(item.avg_cost).toFixed(4),
        motivo: item.reason || '',
        reconfirmado: item.reconfirmed ? 'si' : 'no',
        aplicado_en: item.applied_at ? formatDateTime(item.applied_at) : ''
      }
    })

    const headers = Object.keys(rows[0])
    const csvLines = [headers.join(',')]

    for (const row of rows) {
      const values = headers.map((key) => {
        const raw = String((row as any)[key] ?? '')
        return `"${raw.replace(/"/g, '""')}"`
      })
      csvLines.push(values.join(','))
    }

    const blob = new Blob([csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${session.value.code}-reporte-inventario.csv`
    link.click()
    URL.revokeObjectURL(url)

    message.value = 'Reporte de sesión exportado.'
  } catch (err: any) {
    message.value = err?.message || 'No se pudo exportar el reporte.'
  } finally {
    exportingSession.value = false
  }
}

onMounted(async () => {
  await loadInventory()
})
</script>

<template>
  <div class="space-y-6">
    <section class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      <article class="ui-card">
        <p class="text-xs font-semibold uppercase tracking-wide text-slate-400">Stock total</p>
        <p class="mt-3 text-2xl font-display sm:text-3xl">{{ summary.stockUnits }}</p>
        <p class="mt-1 text-sm text-slate-400">Unidades vendibles en sistema</p>
      </article>

      <article class="ui-card">
        <p class="text-xs font-semibold uppercase tracking-wide text-slate-400">Inventario a costo</p>
        <p class="mt-3 text-2xl font-display text-indigo-600 sm:text-3xl">{{ formatMoney(summary.stockValue) }}</p>
        <p class="mt-1 text-sm text-slate-400">Valor valorizado con costo promedio</p>
      </article>

      <article class="ui-card">
        <p class="text-xs font-semibold uppercase tracking-wide text-slate-400">Stock bajo</p>
        <p class="mt-3 text-2xl font-display text-rose-500 sm:text-3xl">{{ summary.lowStock }}</p>
        <p class="mt-1 text-sm text-slate-400">Productos bajo mínimo</p>
      </article>

      <article class="ui-card">
        <p class="text-xs font-semibold uppercase tracking-wide text-slate-400">Cambios pendientes</p>
        <p class="mt-3 text-2xl font-display sm:text-3xl">{{ summary.changedRows }}</p>
        <p class="mt-1 text-sm text-slate-400">Filas por ajustar</p>
      </article>
    </section>

    <section class="ui-card">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 class="ui-heading">Sesión de conteo</h2>
          <p class="ui-subtitle">Motivo obligatorio por ajuste y reconteo cuando la diferencia es alta.</p>
        </div>

        <div class="grid w-full gap-2 sm:flex sm:w-auto sm:flex-wrap sm:gap-3">
          <button
            v-if="!session"
            class="ui-btn w-full sm:w-auto"
            @click="startSession"
          >
            Iniciar sesión
          </button>
          <button
            v-if="session"
            class="ui-btn-secondary w-full sm:w-auto"
            :disabled="exportingSession"
            @click="exportSessionReport"
          >
            {{ exportingSession ? 'Exportando...' : 'Exportar reporte' }}
          </button>
          <button
            v-if="session"
            class="ui-btn w-full sm:w-auto"
            :disabled="closingSession"
            @click="closeSession"
          >
            {{ closingSession ? 'Cerrando...' : 'Cerrar sesión' }}
          </button>
        </div>
      </div>

      <div class="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <div class="ui-subcard p-3">
          <p class="text-xs text-slate-400">Estado</p>
          <p class="mt-1 font-semibold text-slate-800">
            {{ session ? `Abierta (${session.code})` : 'Sin sesión abierta' }}
          </p>
          <p v-if="session?.opened_at" class="mt-1 text-xs text-slate-400">
            Inicio: {{ formatDateTime(session.opened_at) }}
          </p>
        </div>

        <div class="ui-subcard p-3">
          <p class="text-xs text-slate-400">Productos ajustados</p>
          <p class="mt-1 font-semibold text-slate-800">{{ sessionSummary.adjustedItems }}</p>
          <p class="mt-1 text-xs text-slate-400">Unidades netas: {{ sessionSummary.netUnits }}</p>
        </div>

        <div class="ui-subcard p-3">
          <p class="text-xs text-slate-400">Impacto valorizado</p>
          <p class="mt-1 font-semibold" :class="sessionSummary.netValue < 0 ? 'text-rose-500' : 'text-emerald-500'">
            {{ formatMoney(sessionSummary.netValue) }}
          </p>
          <p class="mt-1 text-xs text-slate-400">Merma registrada: {{ sessionSummary.nonSellable }}</p>
        </div>
      </div>

      <div class="mt-4">
        <label class="ui-label">Notas de sesión</label>
        <textarea
          v-model="sessionNotes"
          class="ui-textarea"
          placeholder="Ejemplo: Conteo general febrero, incluye merma por productos dañados"
        ></textarea>
      </div>

      <div v-if="closedSummary" class="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-600">
        Sesión {{ closedSummary.code }} cerrada ({{ formatDateTime(closedSummary.closedAt) }}). Productos ajustados: {{ closedSummary.adjustedItems }}.
      </div>
    </section>

    <section class="ui-card">
      <div class="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 class="ui-heading">Conteo físico y ajuste de inventario</h2>
          <p class="ui-subtitle">
            Cuando la diferencia sea mayor o igual a {{ HIGH_DIFF_THRESHOLD }}, marca “Reconfirmado” antes de aplicar.
          </p>
        </div>

        <div class="grid w-full gap-2 sm:flex sm:w-auto sm:flex-wrap sm:gap-3">
          <button class="ui-btn-secondary w-full sm:w-auto" @click="resetAllDrafts">Reiniciar cambios</button>
          <button class="ui-btn w-full sm:w-auto" :disabled="saving || !summary.changedRows || !session" @click="applySelectedAdjustments">
            {{ saving ? 'Aplicando...' : `Aplicar ajustes (${summary.changedRows})` }}
          </button>
        </div>
      </div>

      <div class="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <input
          v-model="query"
          type="text"
          class="ui-input sm:col-span-2 lg:col-span-1"
          placeholder="Buscar por código o nombre"
        />

        <label class="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
          <input v-model="onlyLowStock" type="checkbox" class="h-4 w-4 rounded border-slate-300" />
          Solo stock bajo
        </label>

        <label class="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
          <input v-model="onlyChanges" type="checkbox" class="h-4 w-4 rounded border-slate-300" />
          Solo cambios
        </label>
      </div>

      <div v-if="summary.needsReconfirm > 0" class="ui-alert-error mt-4">
        Hay {{ summary.needsReconfirm }} productos con diferencia alta sin reconfirmar.
      </div>

      <div v-if="!session" class="ui-alert mt-4">
        Inicia una sesión de conteo para habilitar la edición de inventario.
      </div>

      <div v-if="message" class="ui-alert mt-4">{{ message }}</div>

      <div class="mt-5 grid gap-3 md:grid-cols-2 xl:hidden">
        <article
          v-for="product in filteredProducts"
          :key="`card-${product.id}`"
          class="space-y-3 rounded-2xl border border-gray-100 bg-white p-4 shadow-sm"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="text-xs font-semibold uppercase tracking-wide text-slate-500">{{ product.sku || '-' }}</p>
              <p class="truncate text-sm font-semibold text-slate-800">{{ product.name }}</p>
              <p class="text-xs text-slate-400">Unidad: {{ product.unit || 'unidad' }}</p>
            </div>
            <span class="ui-pill shrink-0" :class="systemStock(product) <= normalizeUnits(product.min_stock) ? 'ui-pill-low' : ''">
              {{ systemStock(product) }}
            </span>
          </div>

          <div class="grid gap-2 sm:grid-cols-2">
            <label class="text-xs text-slate-400">
              Contado
              <input
                v-model.number="getDraft(product).counted"
                type="number"
                min="0"
                step="1"
                class="ui-input mt-1 w-full"
                inputmode="numeric"
                :disabled="!session"
                @input="sanitizeDraftUnits(product, 'counted')"
                @change="sanitizeDraftUnits(product, 'counted')"
              />
            </label>
            <label class="text-xs text-slate-400">
              No vendible
              <input
                v-model.number="getDraft(product).damaged"
                type="number"
                min="0"
                step="1"
                class="ui-input mt-1 w-full"
                inputmode="numeric"
                :disabled="!session"
                @input="applyDamagedChange(product)"
                @change="applyDamagedChange(product)"
              />
            </label>
          </div>

          <div class="grid gap-2 sm:grid-cols-3">
            <div class="rounded-xl border border-gray-100 bg-white px-3 py-2">
              <p class="text-xs uppercase tracking-wide text-slate-500">Stock final</p>
              <p class="mt-1 text-sm font-semibold text-slate-800">{{ finalSellableStock(product) }}</p>
            </div>
            <div class="rounded-xl border border-gray-100 bg-white px-3 py-2">
              <p class="text-xs uppercase tracking-wide text-slate-500">Ajuste</p>
              <p class="mt-1 text-sm font-semibold">
                <span
                  class="inline-flex rounded-full px-2.5 py-1 text-xs font-semibold"
                  :class="stockDelta(product) < 0 ? 'bg-rose-100 text-rose-500' : stockDelta(product) > 0 ? 'bg-emerald-100 text-emerald-500' : 'bg-slate-100 text-slate-600'"
                >
                  {{ stockDelta(product) > 0 ? '+' : '' }}{{ stockDelta(product) }}
                </span>
              </p>
            </div>
            <div class="rounded-xl border border-gray-100 bg-white px-3 py-2">
              <p class="text-xs uppercase tracking-wide text-slate-500">Stock mínimo</p>
              <p class="mt-1 text-sm font-semibold text-slate-800">{{ normalizeUnits(product.min_stock) }}</p>
            </div>
          </div>

          <div class="space-y-2">
            <p class="text-xs font-semibold uppercase tracking-wide text-slate-400">Motivo</p>
            <select
              v-model="getDraft(product).reasonSelection"
              class="ui-select w-full"
              :disabled="!session"
              @change="syncReason(product)"
            >
              <option value="">Seleccionar</option>
              <option v-for="reason in REASON_PRESETS" :key="reason" :value="reason">{{ reason }}</option>
              <option :value="CUSTOM_REASON">Otro motivo</option>
            </select>
            <input
              v-if="getDraft(product).reasonSelection === CUSTOM_REASON"
              v-model="getDraft(product).customReason"
              type="text"
              class="ui-input w-full"
              placeholder="Escribe motivo"
              :disabled="!session"
              @input="syncReason(product)"
            />
          </div>

          <div class="grid gap-2 sm:grid-cols-2">
            <label class="inline-flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs text-slate-600">
              <input
                v-model="getDraft(product).reconfirm"
                type="checkbox"
                class="h-4 w-4 rounded border-slate-300"
                :disabled="!session || !requiresReconfirm(product)"
                @change="markTouched(product)"
              />
              {{ requiresReconfirm(product) ? 'Reconfirmado' : 'No aplica reconteo' }}
            </label>
            <label class="inline-flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs text-slate-600">
              <input
                v-model="getDraft(product).deactivate"
                type="checkbox"
                class="h-4 w-4 rounded border-slate-300"
                :disabled="!session"
                @change="markTouched(product)"
              />
              No vender
            </label>
          </div>

          <button
            class="ui-btn-secondary w-full"
            :disabled="saving || !session || !hasRowChanges(product)"
            @click="applyAdjustment(product)"
          >
            Aplicar ajuste
          </button>
        </article>
      </div>

      <div class="ui-table-wrap mt-5 hidden xl:block">
        <table class="ui-table min-w-[1320px]">
          <thead class="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:whitespace-nowrap">
            <tr>
              <th>Código</th>
              <th>Producto</th>
              <th>Stock sistema</th>
              <th>Contado</th>
              <th>No vendible</th>
              <th>Stock final</th>
              <th>Ajuste</th>
              <th>Motivo</th>
              <th>Reconfirmado</th>
              <th>Activo</th>
              <th>Acción</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="product in filteredProducts" :key="product.id">
              <td>{{ product.sku || '-' }}</td>
              <td class="min-w-[260px]">
                <p class="font-semibold text-slate-800">{{ product.name }}</p>
                <p class="text-xs text-slate-400">Unidad: {{ product.unit || 'unidad' }}</p>
              </td>
              <td>
                <span class="ui-pill" :class="systemStock(product) <= normalizeUnits(product.min_stock) ? 'ui-pill-low' : ''">
                  {{ systemStock(product) }}
                </span>
              </td>
              <td>
                <input
                  v-model.number="getDraft(product).counted"
                  type="number"
                  min="0"
                  step="1"
                  class="ui-input w-24"
                  inputmode="numeric"
                  :disabled="!session"
                  @input="sanitizeDraftUnits(product, 'counted')"
                  @change="sanitizeDraftUnits(product, 'counted')"
                />
              </td>
              <td>
                <input
                  v-model.number="getDraft(product).damaged"
                  type="number"
                  min="0"
                  step="1"
                  class="ui-input w-24"
                  inputmode="numeric"
                  :disabled="!session"
                  @input="applyDamagedChange(product)"
                  @change="applyDamagedChange(product)"
                />
              </td>
              <td class="font-semibold">{{ finalSellableStock(product) }}</td>
              <td>
                <span
                  class="inline-flex rounded-full px-2.5 py-1 text-xs font-semibold"
                  :class="stockDelta(product) < 0 ? 'bg-rose-100 text-rose-500' : stockDelta(product) > 0 ? 'bg-emerald-100 text-emerald-500' : 'bg-slate-100 text-slate-600'"
                >
                  {{ stockDelta(product) > 0 ? '+' : '' }}{{ stockDelta(product) }}
                </span>
              </td>
              <td>
                <div class="space-y-2">
                  <select
                    v-model="getDraft(product).reasonSelection"
                    class="ui-select w-52"
                    :disabled="!session"
                    @change="syncReason(product)"
                  >
                    <option value="">Seleccionar</option>
                    <option v-for="reason in REASON_PRESETS" :key="reason" :value="reason">{{ reason }}</option>
                    <option :value="CUSTOM_REASON">Otro motivo</option>
                  </select>
                  <input
                    v-if="getDraft(product).reasonSelection === CUSTOM_REASON"
                    v-model="getDraft(product).customReason"
                    type="text"
                    class="ui-input w-52"
                    placeholder="Escribe motivo"
                    :disabled="!session"
                    @input="syncReason(product)"
                  />
                </div>
              </td>
              <td>
                <label class="inline-flex items-center gap-2 text-xs text-slate-600">
                  <input
                    v-model="getDraft(product).reconfirm"
                    type="checkbox"
                    class="h-4 w-4 rounded border-slate-300"
                    :disabled="!session || !requiresReconfirm(product)"
                    @change="markTouched(product)"
                  />
                  {{ requiresReconfirm(product) ? 'Sí' : '-' }}
                </label>
              </td>
              <td>
                <label class="inline-flex items-center gap-2 text-xs text-slate-600">
                  <input
                    v-model="getDraft(product).deactivate"
                    type="checkbox"
                    class="h-4 w-4 rounded border-slate-300"
                    :disabled="!session"
                    @change="markTouched(product)"
                  />
                  No vender
                </label>
              </td>
              <td>
                <button
                  class="ui-btn-secondary px-3 py-2"
                  :disabled="saving || !session || !hasRowChanges(product)"
                  @click="applyAdjustment(product)"
                >
                  Aplicar
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p v-if="!filteredProducts.length && !loading" class="ui-empty-state mt-4">
        No hay productos para el filtro aplicado.
      </p>
    </section>
  </div>
</template>
