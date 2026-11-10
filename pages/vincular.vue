<script setup lang="ts">
// Seller identification for Claude (Yachay connector). Public page: the seller signs in
// here with HIS/HER own POS user, never in the chat.
useHead({ title: 'Vincular Claude · THRANDUIL' })

const route = useRoute()
const code = ref(String(route.query.code || '').toUpperCase().slice(0, 16))
const email = ref('')
const password = ref('')
const loading = ref(false)
const error = ref('')
const done = ref<{ name: string; role: string; expires_at: string } | null>(null)

const roleLabel: Record<string, string> = { owner: 'propietario', manager: 'gerente', cashier: 'cajero' }

const approve = async () => {
  error.value = ''
  loading.value = true
  try {
    const res = await $fetch<{ seller: { name: string; role: string }; expires_at: string }>('/api/agent/identification/approve', {
      method: 'POST',
      body: { user_code: code.value, email: email.value, password: password.value }
    })
    done.value = { ...res.seller, expires_at: res.expires_at }
  } catch (err: any) {
    error.value = err?.data?.statusMessage || 'No se pudo completar la vinculación.'
  } finally {
    password.value = ''
    loading.value = false
  }
}
</script>

<template>
  <div class="mx-auto w-full max-w-md px-4 py-8">
    <section class="ui-card p-6 sm:p-8">
      <BrandLogo subtitle="Control comercial" />
      <template v-if="!done">
        <p class="mt-6 text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">Vincular Claude</p>
        <h2 class="mt-2 text-2xl font-display text-slate-800">Aprobar código de venta por voz</h2>
        <p class="mt-2 text-sm text-slate-500">
          Claude (conector Yachay) pide registrar ventas <strong>a tu nombre</strong> hasta el final de la jornada.
          Aprueba solo si TÚ acabas de pedirlo y el código coincide con el que ves en Claude.
        </p>

        <form class="mt-5 space-y-4" @submit.prevent="approve">
          <div>
            <label class="ui-label" for="code">Código que muestra Claude</label>
            <input id="code" v-model="code" class="ui-input font-mono uppercase tracking-widest" autocomplete="one-time-code" placeholder="ABC-DEFG" required />
          </div>
          <div>
            <label class="ui-label" for="email">Tu correo del POS</label>
            <input id="email" v-model="email" type="email" class="ui-input" autocomplete="username" required />
          </div>
          <div>
            <label class="ui-label" for="password">Tu contraseña del POS</label>
            <input id="password" v-model="password" type="password" class="ui-input" autocomplete="current-password" required />
          </div>
          <button class="ui-btn w-full" type="submit" :disabled="loading">
            {{ loading ? 'Comprobando...' : 'Aprobar y vincular' }}
          </button>
        </form>
        <p class="mt-4 text-xs text-slate-400">Nunca escribas tu contraseña en el chat de Claude. Si no reconoces este código, cierra esta página.</p>
        <div v-if="error" class="ui-alert-error mt-4" role="alert">{{ error }}</div>
      </template>
      <template v-else>
        <h2 class="mt-6 text-2xl font-display text-slate-800">Listo, {{ done.name }}</h2>
        <p class="mt-2 text-sm text-slate-500">
          Claude queda vinculado como {{ roleLabel[done.role] || done.role }} hasta
          {{ new Date(done.expires_at).toLocaleString('es-PE', { timeZone: 'America/Lima' }) }}.
          Vuelve a Claude y dile que ya aprobaste el código.
        </p>
        <p class="mt-4 text-xs text-slate-400">El propietario o el gerente pueden revocar esta vinculación en Usuarios.</p>
      </template>
    </section>
  </div>
</template>
