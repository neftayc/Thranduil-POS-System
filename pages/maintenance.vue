<script setup lang="ts">
definePageMeta({ middleware: ['owner'] })

const loading = ref(false)
const saving = ref(false)
const message = ref('')
const activeTab = ref<'units' | 'payments' | 'customer_groups'>('units')

const units = ref<Array<{ code: string; label: string; active: boolean }>>([])
const paymentMethods = ref<Array<{ code: string; label: string; active: boolean; sort_order: number }>>([])
const customerGroups = ref<Array<{ code: string; label: string; active: boolean; sort_order: number }>>([])

const newUnit = reactive({
  label: ''
})

const newPaymentMethod = reactive({
  label: '',
  sort_order: 100
})

const newCustomerGroup = reactive({
  label: '',
  sort_order: 100
})

const normalizeCode = (value: string) =>
  String(value || '')
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

const prettyCode = (value: string) => String(value || '').replace(/_/g, ' ')

const loadData = async () => {
  loading.value = true
  message.value = ''

  try {
    const data = await $fetch<{
      units: any[]
      paymentMethods: any[]
      customerGroups: any[]
    }>('/api/maintenance')

    units.value = (data.units || []).map((item) => ({
      code: String(item.code || ''),
      label: String(item.label || ''),
      active: item.active !== false
    }))

    paymentMethods.value = (data.paymentMethods || []).map((item) => ({
      code: String(item.code || ''),
      label: String(item.label || ''),
      active: item.active !== false,
      sort_order: Number(item.sort_order || 100)
    }))

    customerGroups.value = (data.customerGroups || []).map((item) => ({
      code: String(item.code || ''),
      label: String(item.label || ''),
      active: item.active !== false,
      sort_order: Number(item.sort_order || 100)
    }))
  } catch (err: any) {
    message.value = err?.data?.statusMessage || err?.message || 'No se pudieron cargar las variables globales.'
  } finally {
    loading.value = false
  }
}

const addUnit = async () => {
  const label = String(newUnit.label || '').trim()
  const code = normalizeCode(label)

  if (!label || !code) {
    message.value = 'Ingresa un nombre válido para la unidad.'
    return
  }

  saving.value = true
  message.value = ''
  try {
    await $fetch('/api/maintenance/unit', {
      method: 'POST',
      body: { code, label }
    })

    newUnit.label = ''
    await loadData()
    message.value = `Unidad creada: ${label}`
  } catch (err: any) {
    message.value = err?.data?.statusMessage || err?.message || 'No se pudo crear la unidad.'
  } finally {
    saving.value = false
  }
}

const saveUnit = async (unit: { code: string; label: string; active: boolean }) => {
  if (!unit.label.trim()) {
    message.value = 'El nombre de la unidad es obligatorio.'
    return
  }

  if (unit.code === 'unidad' && unit.active === false) {
    message.value = 'La unidad base "unidad" no se puede desactivar.'
    return
  }

  saving.value = true
  message.value = ''
  try {
    await $fetch(`/api/maintenance/unit/${unit.code}`, {
      method: 'PATCH',
      body: {
        label: unit.label.trim(),
        active: unit.active
      }
    })
    message.value = `Unidad actualizada: ${unit.label}`
  } catch (err: any) {
    message.value = err?.data?.statusMessage || err?.message || 'No se pudo actualizar la unidad.'
  } finally {
    saving.value = false
  }
}

const addPaymentMethod = async () => {
  const label = String(newPaymentMethod.label || '').trim()
  const code = normalizeCode(label)

  if (!label || !code) {
    message.value = 'Ingresa un nombre válido para el método de pago.'
    return
  }

  saving.value = true
  message.value = ''
  try {
    await $fetch('/api/maintenance/payment-method', {
      method: 'POST',
      body: {
        code,
        label,
        sort_order: Number(newPaymentMethod.sort_order || 100)
      }
    })

    newPaymentMethod.label = ''
    newPaymentMethod.sort_order = 100
    await loadData()
    message.value = `Método de pago creado: ${label}`
  } catch (err: any) {
    message.value = err?.data?.statusMessage || err?.message || 'No se pudo crear el método de pago.'
  } finally {
    saving.value = false
  }
}

const savePaymentMethod = async (method: { code: string; label: string; active: boolean; sort_order: number }) => {
  if (!method.label.trim()) {
    message.value = 'El nombre del método de pago es obligatorio.'
    return
  }

  if (method.code === 'efectivo' && method.active === false) {
    message.value = 'Debes mantener activo al menos "efectivo".'
    return
  }

  saving.value = true
  message.value = ''
  try {
    await $fetch(`/api/maintenance/payment-method/${method.code}`, {
      method: 'PATCH',
      body: {
        label: method.label.trim(),
        active: method.active,
        sort_order: Number(method.sort_order || 100)
      }
    })
    message.value = `Método actualizado: ${method.label}`
  } catch (err: any) {
    message.value = err?.data?.statusMessage || err?.message || 'No se pudo actualizar el método de pago.'
  } finally {
    saving.value = false
  }
}

const addCustomerGroup = async () => {
  const label = String(newCustomerGroup.label || '').trim()
  const code = normalizeCode(label)

  if (!label || !code) {
    message.value = 'Ingresa un nombre válido para el tipo de cliente.'
    return
  }

  saving.value = true
  message.value = ''
  try {
    await $fetch('/api/maintenance/customer-group', {
      method: 'POST',
      body: {
        code,
        label,
        sort_order: Number(newCustomerGroup.sort_order || 100)
      }
    })

    newCustomerGroup.label = ''
    newCustomerGroup.sort_order = 100
    await loadData()
    message.value = `Tipo de cliente creado: ${label}`
  } catch (err: any) {
    message.value = err?.data?.statusMessage || err?.message || 'No se pudo crear el tipo de cliente.'
  } finally {
    saving.value = false
  }
}

const saveCustomerGroup = async (group: { code: string; label: string; active: boolean; sort_order: number }) => {
  if (!group.label.trim()) {
    message.value = 'El nombre del tipo de cliente es obligatorio.'
    return
  }

  if (group.code === 'minorista' && group.active === false) {
    message.value = 'Debes mantener activo al menos "minorista".'
    return
  }

  saving.value = true
  message.value = ''
  try {
    await $fetch(`/api/maintenance/customer-group/${group.code}`, {
      method: 'PATCH',
      body: {
        label: group.label.trim(),
        active: group.active,
        sort_order: Number(group.sort_order || 100)
      }
    })
    message.value = `Tipo de cliente actualizado: ${group.label}`
  } catch (err: any) {
    message.value = err?.data?.statusMessage || err?.message || 'No se pudo actualizar el tipo de cliente.'
  } finally {
    saving.value = false
  }
}

onMounted(loadData)
</script>

<template>
  <div class="space-y-6">
    <section class="ui-card card-hover">
      <h2 class="ui-heading">Mantenimiento</h2>
      <p class="ui-subtitle">Administra variables globales del sistema: unidades, métodos de pago y catálogos de operación.</p>

      <div class="mt-5 flex flex-wrap gap-2">
        <button
          class="rounded-xl px-4 py-2 text-sm font-bold transition-all"
          :class="activeTab === 'units' ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20' : 'border border-gray-200 bg-white text-slate-600 shadow-sm hover:bg-gray-50'"
          @click="activeTab = 'units'"
        >
          Unidades globales
        </button>
        <button
          class="rounded-xl px-4 py-2 text-sm font-bold transition-all"
          :class="activeTab === 'customer_groups' ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20' : 'border border-gray-200 bg-white text-slate-600 shadow-sm hover:bg-gray-50'"
          @click="activeTab = 'customer_groups'"
        >
          Tipos de cliente
        </button>
        <button
          class="rounded-xl px-4 py-2 text-sm font-bold transition-all"
          :class="activeTab === 'payments' ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20' : 'border border-gray-200 bg-white text-slate-600 shadow-sm hover:bg-gray-50'"
          @click="activeTab = 'payments'"
        >
          Métodos de pago
        </button>
      </div>

      <div
        v-if="message"
        class="mt-4"
        :class="message.toLowerCase().includes('no se') ? 'ui-alert-error' : 'ui-alert'"
      >
        {{ message }}
      </div>
    </section>

    <section v-if="activeTab === 'units'" class="ui-card card-hover space-y-5">
      <div class="grid gap-3 sm:grid-cols-[1fr_auto]">
        <div>
          <label class="ui-label">Nueva unidad</label>
          <input
            v-model="newUnit.label"
            class="ui-input"
            type="text"
            placeholder="Ej: Rollo, paquete, estuche"
          />
        </div>
        <div class="flex items-end">
          <button class="ui-btn w-full sm:w-auto" :disabled="saving" @click="addUnit">
            {{ saving ? 'Guardando...' : 'Agregar unidad' }}
          </button>
        </div>
      </div>

      <div class="ui-table-wrap">
        <table class="ui-table">
          <thead>
            <tr>
              <th>Código</th>
              <th>Nombre visible</th>
              <th>Activo</th>
              <th>Acción</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="unit in units" :key="unit.code">
              <td>
                <span class="inline-flex rounded bg-slate-100 px-2 py-1 font-mono text-xs text-slate-500 border border-slate-200">{{ prettyCode(unit.code) }}</span>
              </td>
              <td>
                <input v-model="unit.label" class="ui-input w-56" type="text" />
              </td>
              <td>
                <label class="inline-flex items-center gap-2 text-xs text-slate-600">
                  <input
                    v-model="unit.active"
                    type="checkbox"
                    class="h-4 w-4 rounded border-slate-300"
                    :disabled="unit.code === 'unidad'"
                  />
                  {{ unit.active ? 'Sí' : 'No' }}
                </label>
              </td>
              <td>
                <button class="ui-btn-secondary px-3 py-2" :disabled="saving" @click="saveUnit(unit)">
                  Guardar
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p v-if="!units.length && !loading" class="ui-empty-state">
        No hay unidades configuradas.
      </p>
    </section>

    <section v-if="activeTab === 'payments'" class="ui-card card-hover space-y-5">
      <div class="grid gap-3 sm:grid-cols-[1fr_180px_auto]">
        <div>
          <label class="ui-label">Nuevo método de pago</label>
          <input
            v-model="newPaymentMethod.label"
            class="ui-input"
            type="text"
            placeholder="Ej: Crédito, POS, depósito"
          />
        </div>
        <div>
          <label class="ui-label">Orden</label>
          <input
            v-model.number="newPaymentMethod.sort_order"
            class="ui-input"
            type="number"
            min="1"
            step="1"
          />
        </div>
        <div class="flex items-end">
          <button class="ui-btn w-full sm:w-auto" :disabled="saving" @click="addPaymentMethod">
            {{ saving ? 'Guardando...' : 'Agregar método' }}
          </button>
        </div>
      </div>

      <div class="ui-table-wrap">
        <table class="ui-table">
          <thead>
            <tr>
              <th>Código</th>
              <th>Nombre visible</th>
              <th>Orden</th>
              <th>Activo</th>
              <th>Acción</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="method in paymentMethods" :key="method.code">
              <td>
                <span class="inline-flex rounded bg-slate-100 px-2 py-1 font-mono text-xs text-slate-500 border border-slate-200">{{ prettyCode(method.code) }}</span>
              </td>
              <td>
                <input v-model="method.label" class="ui-input w-56" type="text" />
              </td>
              <td>
                <input
                  v-model.number="method.sort_order"
                  class="ui-input w-24"
                  type="number"
                  min="1"
                  step="1"
                />
              </td>
              <td>
                <label class="inline-flex items-center gap-2 text-xs text-slate-600">
                  <input
                    v-model="method.active"
                    type="checkbox"
                    class="h-4 w-4 rounded border-slate-300"
                    :disabled="method.code === 'efectivo'"
                  />
                  {{ method.active ? 'Sí' : 'No' }}
                </label>
              </td>
              <td>
                <button class="ui-btn-secondary px-3 py-2" :disabled="saving" @click="savePaymentMethod(method)">
                  Guardar
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p v-if="!paymentMethods.length && !loading" class="ui-empty-state">
        No hay métodos de pago configurados.
      </p>
    </section>

    <section v-if="activeTab === 'customer_groups'" class="ui-card card-hover space-y-5">
      <div class="grid gap-3 sm:grid-cols-[1fr_180px_auto]">
        <div>
          <label class="ui-label">Nuevo tipo de cliente</label>
          <input
            v-model="newCustomerGroup.label"
            class="ui-input"
            type="text"
            placeholder="Ej: Distribuidor, Colegio"
          />
        </div>
        <div>
          <label class="ui-label">Orden</label>
          <input
            v-model.number="newCustomerGroup.sort_order"
            class="ui-input"
            type="number"
            min="1"
            step="1"
          />
        </div>
        <div class="flex items-end">
          <button class="ui-btn w-full sm:w-auto" :disabled="saving" @click="addCustomerGroup">
            {{ saving ? 'Guardando...' : 'Agregar tipo' }}
          </button>
        </div>
      </div>

      <div class="ui-table-wrap">
        <table class="ui-table">
          <thead>
            <tr>
              <th>Código</th>
              <th>Nombre visible</th>
              <th>Orden</th>
              <th>Activo</th>
              <th>Acción</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="group in customerGroups" :key="group.code">
              <td>
                <span class="inline-flex rounded bg-slate-100 px-2 py-1 font-mono text-xs text-slate-500 border border-slate-200">{{ prettyCode(group.code) }}</span>
              </td>
              <td>
                <input v-model="group.label" class="ui-input w-56" type="text" />
              </td>
              <td>
                <input
                  v-model.number="group.sort_order"
                  class="ui-input w-24"
                  type="number"
                  min="1"
                  step="1"
                />
              </td>
              <td>
                <label class="inline-flex items-center gap-2 text-xs text-slate-600">
                  <input
                    v-model="group.active"
                    type="checkbox"
                    class="h-4 w-4 rounded border-slate-300"
                    :disabled="group.code === 'minorista'"
                  />
                  {{ group.active ? 'Sí' : 'No' }}
                </label>
              </td>
              <td>
                <button class="ui-btn-secondary px-3 py-2" :disabled="saving" @click="saveCustomerGroup(group)">
                  Guardar
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p v-if="!customerGroups.length && !loading" class="ui-empty-state">
        No hay tipos de cliente configurados.
      </p>
    </section>
  </div>
</template>
