<script setup lang="ts">
const customers = ref<any[]>([])
const customerGroups = ref<Array<{ code: string; label: string }>>([])
const search = ref('')
const message = ref('')
const loading = ref(false)
const showFormModal = ref(false)

const form = reactive({
  id: '',
  name: '',
  phone: '',
  email: '',
  address: '',
  notes: '',
  customer_group: 'minorista'
})

const isEditing = computed(() => Boolean(form.id))

const filteredCustomers = computed(() => {
  const term = search.value.toLowerCase().trim()
  if (!term) return customers.value

  return customers.value.filter((customer) =>
    `${customer.name || ''} ${customer.phone || ''} ${customer.email || ''}`
      .toLowerCase()
      .includes(term)
  )
})

const resetForm = () => {
  form.id = ''
  form.name = ''
  form.phone = ''
  form.email = ''
  form.address = ''
  form.notes = ''
  form.customer_group = 'minorista'
}

const loadCustomers = async () => {
  loading.value = true
  message.value = ''

  try {
    const data = await $fetch<{ customers: any[]; customerGroups: any[] }>('/api/customers/page')
    customers.value = data.customers || []
    customerGroups.value = (data.customerGroups || []).length
      ? (data.customerGroups as any[])
      : [{ code: 'minorista', label: 'Minorista' }]
  } catch (err: any) {
    message.value = err?.data?.statusMessage || err?.message || 'No se pudo cargar clientes.'
  } finally {
    loading.value = false
  }
}

const saveCustomer = async () => {
  message.value = ''
  loading.value = true

  const payload = {
    name: form.name,
    phone: form.phone || null,
    email: form.email || null,
    address: form.address || null,
    notes: form.notes || null,
    customer_group: form.customer_group || 'minorista'
  }

  try {
    await $fetch('/api/customers/save', {
      method: 'POST',
      body: {
        id: form.id || undefined,
        ...payload
      }
    })
    await loadCustomers()
    resetForm()
    message.value = 'Cliente guardado correctamente.'
    showFormModal.value = false
  } catch (err: any) {
    message.value = err?.data?.statusMessage || err?.message || 'No se pudo guardar el cliente.'
  } finally {
    loading.value = false
  }
}

const editCustomer = (customer: any) => {
  form.id = customer.id
  form.name = customer.name || ''
  form.phone = customer.phone || ''
  form.email = customer.email || ''
  form.address = customer.address || ''
  form.notes = customer.notes || ''
  form.customer_group = customer.customer_group || 'minorista'
  showFormModal.value = true
}

const openNewCustomer = () => {
  resetForm()
  message.value = ''
  showFormModal.value = true
}

const closeFormModal = () => {
  showFormModal.value = false
}

const customerGroupLabel = (value: string) => {
  const code = String(value || '').toLowerCase()
  const found = customerGroups.value.find((item) => String(item.code || '').toLowerCase() === code)
  return found?.label || code || 'Minorista'
}

onMounted(loadCustomers)
</script>

<template>
  <div class="space-y-6">
    <section class="ui-card card-hover">
      <div class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 class="ui-heading">Clientes registrados</h2>
          <div class="mt-2 flex flex-wrap gap-2">
            <p class="ui-meta-chip">{{ filteredCustomers.length }} resultados</p>
            <p class="ui-meta-chip">Base comercial</p>
          </div>
        </div>
        <div class="flex w-full flex-wrap items-end justify-end gap-3 sm:w-auto">
          <div class="w-full sm:w-auto">
            <label class="ui-label">Buscar</label>
            <input
              v-model="search"
              type="text"
              class="ui-input w-full sm:w-64"
              placeholder="Nombre, teléfono o email"
            />
          </div>
          <button class="ui-btn h-11" @click="openNewCustomer">
            Nuevo cliente
          </button>
        </div>
      </div>

      <div
        v-if="message"
        class="mt-4"
        :class="message.toLowerCase().includes('no se') || message.toLowerCase().includes('error') ? 'ui-alert-error' : 'ui-alert'"
      >
        {{ message }}
      </div>

      <div class="ui-table-wrap mt-5">
        <table class="ui-table">
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Teléfono</th>
              <th>Email</th>
              <th>Tipo</th>
              <th>Dirección</th>
              <th>Acción</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="customer in filteredCustomers" :key="customer.id">
              <td>
                <div class="flex items-center gap-2">
                  <div class="h-7 w-7 rounded-full border border-indigo-200 bg-indigo-100 text-[11px] font-bold text-indigo-700 flex items-center justify-center">
                    {{ (customer.name || 'C').slice(0, 1).toUpperCase() }}
                  </div>
                  <span class="font-semibold text-slate-800">{{ customer.name }}</span>
                </div>
              </td>
              <td>{{ customer.phone || '-' }}</td>
              <td>{{ customer.email || '-' }}</td>
              <td>
                <span class="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-bold text-slate-600">
                  {{ customerGroupLabel(customer.customer_group) }}
                </span>
              </td>
              <td>{{ customer.address || '-' }}</td>
              <td>
                <button class="ui-btn-secondary px-3 py-2" @click="editCustomer(customer)">Editar</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p v-if="!filteredCustomers.length && !loading" class="ui-empty-state mt-4">
        No hay clientes para mostrar.
      </p>
    </section>

    <Teleport to="body">
      <div
        v-if="showFormModal"
        class="fixed inset-0 z-[1000] flex items-center justify-center p-4"
      >
        <button
          class="absolute inset-0 bg-slate-900/55 backdrop-blur-sm"
          aria-label="Cerrar modal"
          @click="closeFormModal"
        />

        <section class="relative max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-gray-200 bg-white p-6 shadow-2xl sm:p-7">
        <h2 class="ui-heading">{{ isEditing ? 'Editar cliente' : 'Nuevo cliente' }}</h2>
        <p class="ui-subtitle">Guarda datos de contacto para historial de ventas.</p>

        <div class="mt-5 grid gap-4 sm:grid-cols-2">
          <div>
            <label class="ui-label">Nombre</label>
            <input v-model="form.name" type="text" class="ui-input" />
          </div>
          <div>
            <label class="ui-label">Teléfono</label>
            <input v-model="form.phone" type="text" class="ui-input" />
          </div>
          <div>
            <label class="ui-label">Email</label>
            <input v-model="form.email" type="email" class="ui-input" />
          </div>
          <div>
            <label class="ui-label">Dirección</label>
            <input v-model="form.address" type="text" class="ui-input" />
          </div>
          <div>
            <label class="ui-label">Tipo de cliente</label>
            <select v-model="form.customer_group" class="ui-select">
              <option v-for="group in customerGroups" :key="group.code" :value="group.code">
                {{ group.label }}
              </option>
            </select>
          </div>
          <div class="sm:col-span-2">
            <label class="ui-label">Notas</label>
            <textarea v-model="form.notes" class="ui-textarea"></textarea>
          </div>
        </div>

        <div class="mt-6 flex flex-wrap justify-end gap-3">
          <button class="ui-btn-secondary" @click="closeFormModal">Cancelar</button>
          <button class="ui-btn-secondary" @click="resetForm">Limpiar</button>
          <button class="ui-btn" :disabled="loading" @click="saveCustomer">
            {{ loading ? 'Guardando...' : (isEditing ? 'Actualizar cliente' : 'Guardar cliente') }}
          </button>
        </div>
        </section>
      </div>
    </Teleport>
  </div>
</template>
