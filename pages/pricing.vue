<script setup lang="ts">
definePageMeta({ middleware: ['owner'] })

const loading = ref(false)
const saving = ref(false)
const message = ref('')

const products = ref<any[]>([])
const units = ref<Array<{ code: string; label: string }>>([])
const customerGroups = ref<Array<{ code: string; label: string }>>([])

const selectedProductId = ref('')

const presentationRules = ref<any[]>([])
const wholesaleTiers = ref<any[]>([])
const promotions = ref<any[]>([])
const customerGroupPrices = ref<any[]>([])

const newPresentation = reactive({
  unit_name: '',
  customer_group: '',
  price_uom: 0,
  priority: 100,
  active: true
})

const newWholesale = reactive({
  customer_group: '',
  min_qty_base: 1,
  unit_price_base: 0,
  priority: 100,
  active: true
})

const newPromotion = reactive({
  name: '',
  unit_name: '',
  customer_group: '',
  promo_type: 'percent',
  promo_value: 10,
  min_qty_base: 1,
  starts_at: '',
  ends_at: '',
  priority: 100,
  active: true
})

const newCustomerGroupPrice = reactive({
  customer_group: '',
  unit_price_base: 0,
  priority: 100,
  active: true
})

const selectedProduct = computed(() =>
  products.value.find((product) => product.id === selectedProductId.value)
)

const unitLabel = (code: string) =>
  units.value.find((item) => item.code === code)?.label || code || '-'

const customerGroupLabel = (code: string) =>
  customerGroups.value.find((item) => item.code === code)?.label || code || 'Todos'

const toIsoOrNull = (value: string) => {
  const raw = String(value || '').trim()
  if (!raw) return null
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString()
}

const toLocalInput = (value: string | null) => {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const normalizeRuleDates = (rows: any[]) =>
  rows.map((row) => ({
    ...row,
    starts_at_input: toLocalInput(row.starts_at),
    ends_at_input: toLocalInput(row.ends_at)
  }))

const loadRules = async () => {
  if (!selectedProductId.value) {
    presentationRules.value = []
    wholesaleTiers.value = []
    promotions.value = []
    customerGroupPrices.value = []
    return
  }

  loading.value = true
  message.value = ''
  try {
    const productId = selectedProductId.value
    const data = await $fetch<{
      presentationRules: any[]
      wholesaleTiers: any[]
      promotions: any[]
      customerGroupPrices: any[]
    }>(`/api/pricing/rules?product_id=${encodeURIComponent(productId)}`)

    presentationRules.value = normalizeRuleDates(data.presentationRules || [])
    wholesaleTiers.value = normalizeRuleDates(data.wholesaleTiers || [])
    promotions.value = normalizeRuleDates(data.promotions || [])
    customerGroupPrices.value = normalizeRuleDates(data.customerGroupPrices || [])
  } catch (err: any) {
    message.value = err?.data?.statusMessage || err?.message || 'No se pudieron cargar reglas de venta.'
  } finally {
    loading.value = false
  }
}

const loadCatalogs = async () => {
  loading.value = true
  message.value = ''
  try {
    const data = await $fetch<{ products: any[]; units: any[]; customerGroups: any[] }>('/api/pricing/catalogs')

    products.value = data.products || []
    units.value = data.units || []
    customerGroups.value = data.customerGroups || []

    if (!selectedProductId.value && products.value.length) {
      selectedProductId.value = products.value[0].id
    }

    await loadRules()
  } catch (err: any) {
    message.value = err?.data?.statusMessage || err?.message || 'No se pudieron cargar datos de configuración.'
  } finally {
    loading.value = false
  }
}

const addPresentationRule = async () => {
  if (!selectedProductId.value) return
  if (!newPresentation.unit_name) {
    message.value = 'Selecciona unidad para la regla por presentación.'
    return
  }

  saving.value = true
  message.value = ''
  try {
    await $fetch('/api/pricing/presentation', {
      method: 'POST',
      body: {
        product_id: selectedProductId.value,
        unit_name: newPresentation.unit_name,
        customer_group: newPresentation.customer_group || null,
        price_uom: Number(newPresentation.price_uom || 0),
        priority: Number(newPresentation.priority || 100),
        active: newPresentation.active
      }
    })

    newPresentation.unit_name = ''
    newPresentation.customer_group = ''
    newPresentation.price_uom = 0
    newPresentation.priority = 100
    newPresentation.active = true
    await loadRules()
    message.value = 'Regla por presentación creada.'
  } catch (err: any) {
    message.value = err?.data?.statusMessage || err?.message || 'No se pudo crear regla por presentación.'
  } finally {
    saving.value = false
  }
}

const savePresentationRule = async (rule: any) => {
  saving.value = true
  message.value = ''
  try {
    await $fetch(`/api/pricing/presentation/${rule.id}`, {
      method: 'PATCH',
      body: {
        unit_name: rule.unit_name,
        customer_group: rule.customer_group || null,
        price_uom: Number(rule.price_uom || 0),
        priority: Number(rule.priority || 100),
        active: rule.active
      }
    })
    message.value = 'Regla por presentación actualizada.'
  } catch (err: any) {
    message.value = err?.data?.statusMessage || err?.message || 'No se pudo actualizar regla por presentación.'
  } finally {
    saving.value = false
  }
}

const removePresentationRule = async (id: string) => {
  saving.value = true
  message.value = ''
  try {
    await $fetch(`/api/pricing/presentation/${id}`, { method: 'DELETE' })
    await loadRules()
    message.value = 'Regla por presentación eliminada.'
  } catch (err: any) {
    message.value = err?.data?.statusMessage || err?.message || 'No se pudo eliminar regla por presentación.'
  } finally {
    saving.value = false
  }
}

const addWholesaleTier = async () => {
  if (!selectedProductId.value) return
  if (Number(newWholesale.min_qty_base || 0) <= 0) {
    message.value = 'La cantidad mínima debe ser mayor a 0.'
    return
  }

  saving.value = true
  message.value = ''
  try {
    await $fetch('/api/pricing/wholesale', {
      method: 'POST',
      body: {
        product_id: selectedProductId.value,
        customer_group: newWholesale.customer_group || null,
        min_qty_base: Number(newWholesale.min_qty_base || 0),
        unit_price_base: Number(newWholesale.unit_price_base || 0),
        priority: Number(newWholesale.priority || 100),
        active: newWholesale.active
      }
    })

    newWholesale.customer_group = ''
    newWholesale.min_qty_base = 1
    newWholesale.unit_price_base = 0
    newWholesale.priority = 100
    newWholesale.active = true
    await loadRules()
    message.value = 'Escala mayorista creada.'
  } catch (err: any) {
    message.value = err?.data?.statusMessage || err?.message || 'No se pudo crear escala mayorista.'
  } finally {
    saving.value = false
  }
}

const saveWholesaleTier = async (rule: any) => {
  saving.value = true
  message.value = ''
  try {
    await $fetch(`/api/pricing/wholesale/${rule.id}`, {
      method: 'PATCH',
      body: {
        customer_group: rule.customer_group || null,
        min_qty_base: Number(rule.min_qty_base || 0),
        unit_price_base: Number(rule.unit_price_base || 0),
        priority: Number(rule.priority || 100),
        active: rule.active
      }
    })
    message.value = 'Escala mayorista actualizada.'
  } catch (err: any) {
    message.value = err?.data?.statusMessage || err?.message || 'No se pudo actualizar escala mayorista.'
  } finally {
    saving.value = false
  }
}

const removeWholesaleTier = async (id: string) => {
  saving.value = true
  message.value = ''
  try {
    await $fetch(`/api/pricing/wholesale/${id}`, { method: 'DELETE' })
    await loadRules()
    message.value = 'Escala mayorista eliminada.'
  } catch (err: any) {
    message.value = err?.data?.statusMessage || err?.message || 'No se pudo eliminar escala mayorista.'
  } finally {
    saving.value = false
  }
}

const addPromotion = async () => {
  if (!selectedProductId.value) return
  if (!newPromotion.name.trim()) {
    message.value = 'Ingresa nombre de promoción.'
    return
  }
  if (!newPromotion.starts_at) {
    message.value = 'Define fecha/hora de inicio para promoción.'
    return
  }

  saving.value = true
  message.value = ''
  try {
    await $fetch('/api/pricing/promotion', {
      method: 'POST',
      body: {
        product_id: selectedProductId.value,
        name: newPromotion.name.trim(),
        unit_name: newPromotion.unit_name || null,
        customer_group: newPromotion.customer_group || null,
        promo_type: newPromotion.promo_type,
        promo_value: Number(newPromotion.promo_value || 0),
        min_qty_base: Number(newPromotion.min_qty_base || 1),
        starts_at: toIsoOrNull(newPromotion.starts_at),
        ends_at: toIsoOrNull(newPromotion.ends_at),
        priority: Number(newPromotion.priority || 100),
        active: newPromotion.active
      }
    })

    newPromotion.name = ''
    newPromotion.unit_name = ''
    newPromotion.customer_group = ''
    newPromotion.promo_type = 'percent'
    newPromotion.promo_value = 10
    newPromotion.min_qty_base = 1
    newPromotion.starts_at = ''
    newPromotion.ends_at = ''
    newPromotion.priority = 100
    newPromotion.active = true
    await loadRules()
    message.value = 'Promoción creada.'
  } catch (err: any) {
    message.value = err?.data?.statusMessage || err?.message || 'No se pudo crear promoción.'
  } finally {
    saving.value = false
  }
}

const savePromotion = async (rule: any) => {
  saving.value = true
  message.value = ''
  try {
    await $fetch(`/api/pricing/promotion/${rule.id}`, {
      method: 'PATCH',
      body: {
        name: String(rule.name || '').trim(),
        unit_name: rule.unit_name || null,
        customer_group: rule.customer_group || null,
        promo_type: rule.promo_type,
        promo_value: Number(rule.promo_value || 0),
        min_qty_base: Number(rule.min_qty_base || 1),
        starts_at: toIsoOrNull(rule.starts_at_input),
        ends_at: toIsoOrNull(rule.ends_at_input),
        priority: Number(rule.priority || 100),
        active: rule.active
      }
    })
    message.value = 'Promoción actualizada.'
    await loadRules()
  } catch (err: any) {
    message.value = err?.data?.statusMessage || err?.message || 'No se pudo actualizar promoción.'
  } finally {
    saving.value = false
  }
}

const removePromotion = async (id: string) => {
  saving.value = true
  message.value = ''
  try {
    await $fetch(`/api/pricing/promotion/${id}`, { method: 'DELETE' })
    await loadRules()
    message.value = 'Promoción eliminada.'
  } catch (err: any) {
    message.value = err?.data?.statusMessage || err?.message || 'No se pudo eliminar promoción.'
  } finally {
    saving.value = false
  }
}

const addCustomerGroupPrice = async () => {
  if (!selectedProductId.value) return
  saving.value = true
  message.value = ''
  try {
    await $fetch('/api/pricing/customer-group-price', {
      method: 'POST',
      body: {
        product_id: selectedProductId.value,
        customer_group: newCustomerGroupPrice.customer_group || null,
        unit_price_base: Number(newCustomerGroupPrice.unit_price_base || 0),
        priority: Number(newCustomerGroupPrice.priority || 100),
        active: newCustomerGroupPrice.active
      }
    })

    newCustomerGroupPrice.customer_group = ''
    newCustomerGroupPrice.unit_price_base = 0
    newCustomerGroupPrice.priority = 100
    newCustomerGroupPrice.active = true
    await loadRules()
    message.value = 'Precio por tipo de cliente creado.'
  } catch (err: any) {
    message.value = err?.data?.statusMessage || err?.message || 'No se pudo crear precio por tipo de cliente.'
  } finally {
    saving.value = false
  }
}

const saveCustomerGroupPrice = async (rule: any) => {
  saving.value = true
  message.value = ''
  try {
    await $fetch(`/api/pricing/customer-group-price/${rule.id}`, {
      method: 'PATCH',
      body: {
        customer_group: rule.customer_group || null,
        unit_price_base: Number(rule.unit_price_base || 0),
        priority: Number(rule.priority || 100),
        active: rule.active
      }
    })
    message.value = 'Precio por tipo de cliente actualizado.'
  } catch (err: any) {
    message.value = err?.data?.statusMessage || err?.message || 'No se pudo actualizar precio por tipo de cliente.'
  } finally {
    saving.value = false
  }
}

const removeCustomerGroupPrice = async (id: string) => {
  saving.value = true
  message.value = ''
  try {
    await $fetch(`/api/pricing/customer-group-price/${id}`, { method: 'DELETE' })
    await loadRules()
    message.value = 'Precio por tipo de cliente eliminado.'
  } catch (err: any) {
    message.value = err?.data?.statusMessage || err?.message || 'No se pudo eliminar precio por tipo de cliente.'
  } finally {
    saving.value = false
  }
}

watch(selectedProductId, () => {
  loadRules()
})

onMounted(loadCatalogs)
</script>

<template>
  <div class="space-y-6">
    <section class="ui-card card-hover">
      <div class="grid gap-4 lg:grid-cols-[1fr_auto]">
        <div>
          <h2 class="ui-heading">Reglas de Venta</h2>
          <p class="ui-subtitle">Configura precios por presentación, mayorista, promociones y tipo de cliente.</p>
          <div v-if="selectedProductId" class="mt-2 flex flex-wrap gap-2">
            <span class="ui-meta-chip">Producto seleccionado</span>
            <span class="ui-meta-chip">Motor de precios activo</span>
          </div>
        </div>
        <div class="min-w-[320px]">
          <label class="ui-label">Producto</label>
          <select v-model="selectedProductId" class="ui-select">
            <option value="">Seleccionar</option>
            <option v-for="product in products" :key="product.id" :value="product.id">
              {{ product.name }} {{ product.sku ? `(${product.sku})` : '' }}
            </option>
          </select>
        </div>
      </div>

      <div v-if="selectedProduct" class="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
        Base: <span class="font-semibold text-indigo-600">{{ selectedProduct.unit }}</span>
        | Precio base: <span class="font-semibold text-indigo-600">S/ {{ Number(selectedProduct.sale_price || 0).toFixed(2) }}</span>
      </div>

      <div
        v-if="message"
        class="mt-4"
        :class="message.toLowerCase().includes('no se pudo') || message.toLowerCase().includes('error') ? 'ui-alert-error' : 'ui-alert'"
      >
        {{ message }}
      </div>
    </section>

    <section v-if="selectedProductId" class="ui-card card-hover space-y-4">
      <h3 class="ui-heading">Precio Por Presentación</h3>
      <div class="grid gap-3 lg:grid-cols-[1fr_1fr_180px_130px_auto]">
        <select v-model="newPresentation.unit_name" class="ui-select">
          <option value="">Unidad</option>
          <option v-for="unit in units" :key="unit.code" :value="unit.code">{{ unit.label }}</option>
        </select>
        <select v-model="newPresentation.customer_group" class="ui-select">
          <option value="">Todos los clientes</option>
          <option v-for="group in customerGroups" :key="group.code" :value="group.code">{{ group.label }}</option>
        </select>
        <input v-model.number="newPresentation.price_uom" class="ui-input" type="number" min="0" step="0.01" placeholder="Precio" />
        <input v-model.number="newPresentation.priority" class="ui-input" type="number" min="1" step="1" placeholder="Prioridad" />
        <button class="ui-btn" :disabled="saving" @click="addPresentationRule">Agregar</button>
      </div>

      <div class="ui-table-wrap">
        <table class="ui-table">
          <thead>
            <tr>
              <th>Unidad</th>
              <th>Cliente</th>
              <th>Precio</th>
              <th>Prioridad</th>
              <th>Activo</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="rule in presentationRules" :key="rule.id">
              <td>
                <select v-model="rule.unit_name" class="ui-select w-44">
                  <option v-for="unit in units" :key="unit.code" :value="unit.code">{{ unit.label }}</option>
                </select>
              </td>
              <td>
                <select v-model="rule.customer_group" class="ui-select w-44">
                  <option :value="null">Todos</option>
                  <option v-for="group in customerGroups" :key="group.code" :value="group.code">{{ group.label }}</option>
                </select>
              </td>
              <td><input v-model.number="rule.price_uom" class="ui-input w-28" type="number" min="0" step="0.01" /></td>
              <td><input v-model.number="rule.priority" class="ui-input w-24" type="number" min="1" step="1" /></td>
              <td><input v-model="rule.active" type="checkbox" class="h-4 w-4 rounded border-slate-300" /></td>
              <td class="flex gap-2">
                <button class="ui-btn-secondary px-3 py-2" :disabled="saving" @click="savePresentationRule(rule)">Guardar</button>
                <button class="ui-btn-secondary px-3 py-2" :disabled="saving" @click="removePresentationRule(rule.id)">Eliminar</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section v-if="selectedProductId" class="ui-card card-hover space-y-4">
      <h3 class="ui-heading">Escala Mayorista</h3>
      <div class="grid gap-3 lg:grid-cols-[1fr_180px_180px_130px_auto]">
        <select v-model="newWholesale.customer_group" class="ui-select">
          <option value="">Todos los clientes</option>
          <option v-for="group in customerGroups" :key="group.code" :value="group.code">{{ group.label }}</option>
        </select>
        <input v-model.number="newWholesale.min_qty_base" class="ui-input" type="number" min="1" step="1" placeholder="Min base" />
        <input v-model.number="newWholesale.unit_price_base" class="ui-input" type="number" min="0" step="0.01" placeholder="Precio base" />
        <input v-model.number="newWholesale.priority" class="ui-input" type="number" min="1" step="1" placeholder="Prioridad" />
        <button class="ui-btn" :disabled="saving" @click="addWholesaleTier">Agregar</button>
      </div>

      <div class="ui-table-wrap">
        <table class="ui-table">
          <thead>
            <tr>
              <th>Cliente</th>
              <th>Min base</th>
              <th>Precio base</th>
              <th>Prioridad</th>
              <th>Activo</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="rule in wholesaleTiers" :key="rule.id">
              <td>
                <select v-model="rule.customer_group" class="ui-select w-44">
                  <option :value="null">Todos</option>
                  <option v-for="group in customerGroups" :key="group.code" :value="group.code">{{ group.label }}</option>
                </select>
              </td>
              <td><input v-model.number="rule.min_qty_base" class="ui-input w-24" type="number" min="1" step="1" /></td>
              <td><input v-model.number="rule.unit_price_base" class="ui-input w-28" type="number" min="0" step="0.01" /></td>
              <td><input v-model.number="rule.priority" class="ui-input w-24" type="number" min="1" step="1" /></td>
              <td><input v-model="rule.active" type="checkbox" class="h-4 w-4 rounded border-slate-300" /></td>
              <td class="flex gap-2">
                <button class="ui-btn-secondary px-3 py-2" :disabled="saving" @click="saveWholesaleTier(rule)">Guardar</button>
                <button class="ui-btn-secondary px-3 py-2" :disabled="saving" @click="removeWholesaleTier(rule.id)">Eliminar</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section v-if="selectedProductId" class="ui-card card-hover space-y-4">
      <h3 class="ui-heading">Promociones Temporales</h3>
      <div class="grid gap-3 lg:grid-cols-6">
        <input v-model="newPromotion.name" class="ui-input" type="text" placeholder="Nombre promo" />
        <select v-model="newPromotion.promo_type" class="ui-select">
          <option value="percent">% descuento</option>
          <option value="fixed_price_uom">Precio fijo por unidad comercial</option>
        </select>
        <input v-model.number="newPromotion.promo_value" class="ui-input" type="number" min="0.01" step="0.01" placeholder="Valor" />
        <select v-model="newPromotion.unit_name" class="ui-select">
          <option value="">Todas las unidades</option>
          <option v-for="unit in units" :key="unit.code" :value="unit.code">{{ unit.label }}</option>
        </select>
        <select v-model="newPromotion.customer_group" class="ui-select">
          <option value="">Todos los clientes</option>
          <option v-for="group in customerGroups" :key="group.code" :value="group.code">{{ group.label }}</option>
        </select>
        <input v-model.number="newPromotion.min_qty_base" class="ui-input" type="number" min="1" step="1" placeholder="Min base" />
      </div>
      <div class="grid gap-3 lg:grid-cols-[1fr_1fr_160px_140px_auto]">
        <input v-model="newPromotion.starts_at" class="ui-input" type="datetime-local" />
        <input v-model="newPromotion.ends_at" class="ui-input" type="datetime-local" />
        <input v-model.number="newPromotion.priority" class="ui-input" type="number" min="1" step="1" placeholder="Prioridad" />
        <label class="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
          <input v-model="newPromotion.active" type="checkbox" class="h-4 w-4 rounded border-slate-300" />
          Activa
        </label>
        <button class="ui-btn" :disabled="saving" @click="addPromotion">Agregar</button>
      </div>

      <div class="ui-table-wrap">
        <table class="ui-table">
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Tipo</th>
              <th>Valor</th>
              <th>Unidad</th>
              <th>Cliente</th>
              <th>Min base</th>
              <th>Inicio</th>
              <th>Fin</th>
              <th>Activo</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="rule in promotions" :key="rule.id">
              <td><input v-model="rule.name" class="ui-input w-44" type="text" /></td>
              <td>
                <select v-model="rule.promo_type" class="ui-select w-40">
                  <option value="percent">% descuento</option>
                  <option value="fixed_price_uom">Precio fijo UOM</option>
                </select>
              </td>
              <td><input v-model.number="rule.promo_value" class="ui-input w-24" type="number" min="0.01" step="0.01" /></td>
              <td>
                <select v-model="rule.unit_name" class="ui-select w-36">
                  <option :value="null">Todas</option>
                  <option v-for="unit in units" :key="unit.code" :value="unit.code">{{ unit.label }}</option>
                </select>
              </td>
              <td>
                <select v-model="rule.customer_group" class="ui-select w-40">
                  <option :value="null">Todos</option>
                  <option v-for="group in customerGroups" :key="group.code" :value="group.code">{{ group.label }}</option>
                </select>
              </td>
              <td><input v-model.number="rule.min_qty_base" class="ui-input w-20" type="number" min="1" step="1" /></td>
              <td><input v-model="rule.starts_at_input" class="ui-input w-44" type="datetime-local" /></td>
              <td><input v-model="rule.ends_at_input" class="ui-input w-44" type="datetime-local" /></td>
              <td><input v-model="rule.active" type="checkbox" class="h-4 w-4 rounded border-slate-300" /></td>
              <td class="flex gap-2">
                <button class="ui-btn-secondary px-3 py-2" :disabled="saving" @click="savePromotion(rule)">Guardar</button>
                <button class="ui-btn-secondary px-3 py-2" :disabled="saving" @click="removePromotion(rule.id)">Eliminar</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section v-if="selectedProductId" class="ui-card card-hover space-y-4">
      <h3 class="ui-heading">Precio Por Tipo de Cliente</h3>
      <div class="grid gap-3 lg:grid-cols-[1fr_180px_130px_auto]">
        <select v-model="newCustomerGroupPrice.customer_group" class="ui-select">
          <option value="">Todos los clientes</option>
          <option v-for="group in customerGroups" :key="group.code" :value="group.code">{{ group.label }}</option>
        </select>
        <input v-model.number="newCustomerGroupPrice.unit_price_base" class="ui-input" type="number" min="0" step="0.01" placeholder="Precio base" />
        <input v-model.number="newCustomerGroupPrice.priority" class="ui-input" type="number" min="1" step="1" placeholder="Prioridad" />
        <button class="ui-btn" :disabled="saving" @click="addCustomerGroupPrice">Agregar</button>
      </div>

      <div class="ui-table-wrap">
        <table class="ui-table">
          <thead>
            <tr>
              <th>Cliente</th>
              <th>Precio base</th>
              <th>Prioridad</th>
              <th>Activo</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="rule in customerGroupPrices" :key="rule.id">
              <td>
                <select v-model="rule.customer_group" class="ui-select w-44">
                  <option :value="null">Todos</option>
                  <option v-for="group in customerGroups" :key="group.code" :value="group.code">{{ group.label }}</option>
                </select>
              </td>
              <td><input v-model.number="rule.unit_price_base" class="ui-input w-28" type="number" min="0" step="0.01" /></td>
              <td><input v-model.number="rule.priority" class="ui-input w-24" type="number" min="1" step="1" /></td>
              <td><input v-model="rule.active" type="checkbox" class="h-4 w-4 rounded border-slate-300" /></td>
              <td class="flex gap-2">
                <button class="ui-btn-secondary px-3 py-2" :disabled="saving" @click="saveCustomerGroupPrice(rule)">Guardar</button>
                <button class="ui-btn-secondary px-3 py-2" :disabled="saving" @click="removeCustomerGroupPrice(rule.id)">Eliminar</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
