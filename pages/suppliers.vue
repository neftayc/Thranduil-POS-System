<script setup lang="ts">
const suppliers = ref<any[]>([])
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
  notes: ''
})

const isEditing = computed(() => Boolean(form.id))

const filteredSuppliers = computed(() => {
  const term = search.value.toLowerCase().trim()
  if (!term) return suppliers.value

  return suppliers.value.filter((supplier) =>
    `${supplier.name || ''} ${supplier.phone || ''} ${supplier.email || ''}`
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
}

const loadSuppliers = async () => {
  loading.value = true
  message.value = ''

  try {
    const data = await $fetch<{ suppliers: any[] }>('/api/suppliers')
    suppliers.value = data.suppliers || []
  } catch (err: any) {
    message.value = err?.data?.statusMessage || err?.message || 'No se pudo cargar proveedores.'
  } finally {
    loading.value = false
  }
}

const saveSupplier = async () => {
  message.value = ''
  loading.value = true

  const payload = {
    name: form.name,
    phone: form.phone || null,
    email: form.email || null,
    address: form.address || null,
    notes: form.notes || null
  }

  try {
    await $fetch('/api/suppliers/save', {
      method: 'POST',
      body: {
        id: form.id || undefined,
        ...payload
      }
    })
    await loadSuppliers()
    resetForm()
    message.value = 'Proveedor guardado correctamente.'
    showFormModal.value = false
  } catch (err: any) {
    message.value = err?.data?.statusMessage || err?.message || 'No se pudo guardar el proveedor.'
  } finally {
    loading.value = false
  }
}

const editSupplier = (supplier: any) => {
  form.id = supplier.id
  form.name = supplier.name || ''
  form.phone = supplier.phone || ''
  form.email = supplier.email || ''
  form.address = supplier.address || ''
  form.notes = supplier.notes || ''
  showFormModal.value = true
}

const openNewSupplier = () => {
  resetForm()
  message.value = ''
  showFormModal.value = true
}

const closeFormModal = () => {
  showFormModal.value = false
}

onMounted(loadSuppliers)
</script>

<template>
  <div class="space-y-6">
    <section class="ui-card card-hover">
      <div class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 class="ui-heading">Proveedores registrados</h2>
          <div class="mt-2 flex flex-wrap gap-2">
            <p class="ui-meta-chip">{{ filteredSuppliers.length }} resultados</p>
            <p class="ui-meta-chip">Contactos de compra</p>
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
          <button class="ui-btn h-11" @click="openNewSupplier">
            Nuevo proveedor
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
              <th>Dirección</th>
              <th>Acción</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="supplier in filteredSuppliers" :key="supplier.id">
              <td>
                <div class="flex items-center gap-2">
                  <div class="h-7 w-7 rounded-full border border-indigo-200 bg-indigo-100 text-[11px] font-bold text-indigo-700 flex items-center justify-center">
                    {{ (supplier.name || 'P').slice(0, 1).toUpperCase() }}
                  </div>
                  <span class="font-semibold text-slate-800">{{ supplier.name }}</span>
                </div>
              </td>
              <td>{{ supplier.phone || '-' }}</td>
              <td>{{ supplier.email || '-' }}</td>
              <td>{{ supplier.address || '-' }}</td>
              <td>
                <button class="ui-btn-secondary px-3 py-2" @click="editSupplier(supplier)">Editar</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p v-if="!filteredSuppliers.length && !loading" class="ui-empty-state mt-4">
        No hay proveedores para mostrar.
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
        <h2 class="ui-heading">{{ isEditing ? 'Editar proveedor' : 'Nuevo proveedor' }}</h2>
        <p class="ui-subtitle">Gestiona tus contactos para registrar compras con trazabilidad.</p>

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
          <div class="sm:col-span-2">
            <label class="ui-label">Notas</label>
            <textarea v-model="form.notes" class="ui-textarea"></textarea>
          </div>
        </div>

        <div class="mt-6 flex flex-wrap justify-end gap-3">
          <button class="ui-btn-secondary" @click="closeFormModal">Cancelar</button>
          <button class="ui-btn-secondary" @click="resetForm">Limpiar</button>
          <button class="ui-btn" :disabled="loading" @click="saveSupplier">
            {{ loading ? 'Guardando...' : (isEditing ? 'Actualizar proveedor' : 'Guardar proveedor') }}
          </button>
        </div>
        </section>
      </div>
    </Teleport>
  </div>
</template>
