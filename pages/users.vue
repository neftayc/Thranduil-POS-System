<script setup lang="ts">
definePageMeta({ middleware: ['owner'] })

const users = ref<any[]>([])
const message = ref('')
const loading = ref(false)

const form = reactive({
  email: '',
  password: '',
  full_name: '',
  role: 'cashier'
})

const resetForm = () => {
  form.email = ''
  form.password = ''
  form.full_name = ''
  form.role = 'cashier'
}

const loadUsers = async () => {
  message.value = ''
  try {
    const data = await $fetch<{ users: any[] }>('/api/admin/users', {
      method: 'GET'
    })
    users.value = data.users || []
  } catch (err: any) {
    message.value = err?.data?.statusMessage || err?.message || 'No se pudo cargar usuarios.'
  }
}

const createUser = async () => {
  message.value = ''
  loading.value = true
  try {
    await $fetch('/api/admin/create-user', {
      method: 'POST',
      body: {
        email: form.email,
        password: form.password,
        full_name: form.full_name,
        role: form.role
      }
    })

    resetForm()
    await loadUsers()
    message.value = 'Usuario creado correctamente.'
  } catch (err: any) {
    message.value = err?.data?.statusMessage || err?.message || 'No se pudo crear usuario.'
  } finally {
    loading.value = false
  }
}

const updateRole = async (userId: string, role: string) => {
  message.value = ''
  try {
    await $fetch('/api/admin/update-role', {
      method: 'POST',
      body: {
        user_id: userId,
        role
      }
    })
    await loadUsers()
    message.value = 'Rol actualizado.'
  } catch (err: any) {
    message.value = err?.data?.statusMessage || err?.message || 'No se pudo actualizar el rol.'
  }
}

const onRoleChange = (event: Event, userId: string) => {
  const target = event.target as HTMLSelectElement | null
  if (!target) return
  updateRole(userId, target.value)
}

// Sessions opened from /vincular so Claude can sell as a given seller.
const claudeSessions = ref<any[]>([])
const sessionsMessage = ref('')
const loadClaudeSessions = async () => {
  try {
    const data = await $fetch<{ sessions: any[] }>('/api/agent/sessions')
    claudeSessions.value = data.sessions || []
    sessionsMessage.value = ''
  } catch (err: any) {
    sessionsMessage.value = err?.data?.statusMessage || 'No se pudieron cargar las sesiones de Claude.'
  }
}
const revokeClaudeSession = async (id: string) => {
  try {
    const res = await $fetch<{ supabase_signed_out: boolean }>('/api/agent/sessions/revoke', { method: 'POST', body: { id } })
    sessionsMessage.value = res.supabase_signed_out
      ? 'Sesión revocada. Claude ya no puede vender con ella.'
      : 'Sesión revocada en el POS (Claude ya no puede vender con ella). No se pudo cerrar la sesión en Supabase; quedó registrado.'
    await loadClaudeSessions()
  } catch (err: any) {
    sessionsMessage.value = err?.data?.statusMessage || 'No se pudo revocar la sesión.'
  }
}
const formatDate = (ms: number) => new Date(ms).toLocaleString('es-PE', { timeZone: 'America/Lima' })

onMounted(() => {
  loadUsers()
  loadClaudeSessions()
})
</script>

<template>
  <div class="space-y-6">
    <section class="ui-card">
      <h2 class="ui-heading">Gestión de usuarios</h2>
      <p class="ui-subtitle">Solo el propietario puede crear usuarios y administrar roles.</p>

      <div class="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div>
          <label class="ui-label">Nombre completo</label>
          <input v-model="form.full_name" class="ui-input" type="text" placeholder="Nombre del empleado" />
        </div>
        <div>
          <label class="ui-label">Correo</label>
          <input v-model="form.email" class="ui-input" type="email" placeholder="correo@tienda.com" />
        </div>
        <div>
          <label class="ui-label">Contraseña</label>
          <input v-model="form.password" class="ui-input" type="password" placeholder="Mínimo 6 caracteres" />
        </div>
        <div>
          <label class="ui-label">Rol</label>
          <select v-model="form.role" class="ui-select">
            <option value="owner">Owner</option>
            <option value="manager">Manager</option>
            <option value="cashier">Cashier</option>
          </select>
        </div>
      </div>

      <div class="mt-5 flex flex-wrap gap-3">
        <button class="ui-btn" :disabled="loading" @click="createUser">
          {{ loading ? 'Creando...' : 'Crear usuario' }}
        </button>
        <button class="ui-btn-secondary" @click="resetForm">Limpiar</button>
      </div>

      <div
        v-if="message"
        class="mt-4"
        :class="message.toLowerCase().includes('no se pudo') ? 'ui-alert-error' : 'ui-alert'"
      >
        {{ message }}
      </div>
    </section>

    <section class="ui-card">
      <h2 class="ui-heading">Usuarios registrados</h2>
      <p class="ui-subtitle">Administra permisos por perfil.</p>

      <div class="ui-table-wrap mt-5">
        <table class="ui-table">
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Email</th>
              <th>Rol</th>
              <th>Creado</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="user in users" :key="user.id">
              <td class="font-semibold text-slate-800">{{ user.profile?.full_name || '-' }}</td>
              <td>{{ user.email || '-' }}</td>
              <td>
                <select
                  :value="user.profile?.role || 'cashier'"
                  class="ui-select w-36"
                  @change="onRoleChange($event, user.id)"
                >
                  <option value="owner">Owner</option>
                  <option value="manager">Manager</option>
                  <option value="cashier">Cashier</option>
                </select>
              </td>
              <td>{{ new Date(user.created_at).toLocaleDateString() }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p v-if="!users.length" class="ui-empty-state mt-4">Sin usuarios aún.</p>
    </section>

    <section class="ui-card">
      <h2 class="ui-heading">Sesiones de Claude (ventas por voz)</h2>
      <p class="ui-subtitle">Vinculaciones aprobadas por cada vendedor en /vincular. Vencen al final de la jornada.</p>
      <div class="ui-table-wrap mt-5">
        <table class="ui-table">
          <thead>
            <tr>
              <th>Vendedor</th>
              <th>Rol</th>
              <th>Inicio</th>
              <th>Vence</th>
              <th>Estado</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="session in claudeSessions" :key="session.id">
              <td class="font-semibold text-slate-800">{{ session.name }}</td>
              <td>{{ session.role }}</td>
              <td>{{ formatDate(session.created_at) }}</td>
              <td>{{ formatDate(session.expires_at) }}</td>
              <td>{{ session.active ? 'Activa' : session.revoked_at ? 'Revocada' : 'Vencida' }}</td>
              <td>
                <button v-if="session.active" class="ui-btn-secondary" @click="revokeClaudeSession(session.id)">Revocar</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="!claudeSessions.length" class="ui-empty-state mt-4">Sin sesiones de Claude.</p>
      <div v-if="sessionsMessage" class="ui-alert mt-4">{{ sessionsMessage }}</div>
    </section>
  </div>
</template>
