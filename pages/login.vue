<script setup lang="ts">
const brandName = 'THRANDUIL'

const email = ref('')
const password = ref('')
const fullName = ref('')
const isSignUp = ref(false)
const message = ref('')
const loading = ref(false)

const submit = async () => {
  message.value = ''
  loading.value = true
  try {
    if (isSignUp.value) {
      const res = await $fetch<{ ok: boolean; message?: string }>('/api/auth/sign-up', {
        method: 'POST',
        body: {
          email: email.value,
          password: password.value,
          full_name: fullName.value
        }
      })
      message.value = res?.message || 'Cuenta creada. Revisa tu correo si Supabase requiere confirmacion.'
      isSignUp.value = false
      return
    }

    await $fetch('/api/auth/sign-in', {
      method: 'POST',
      body: {
        email: email.value,
        password: password.value
      }
    })

    await navigateTo('/')
  } catch (err: any) {
    message.value = err?.data?.statusMessage || err?.message || 'Error al iniciar sesion.'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="mx-auto grid w-full max-w-6xl items-stretch gap-6 lg:grid-cols-[1.15fr_1fr]">
    <section class="hidden overflow-hidden rounded-3xl border border-slate-800 bg-slate-900 p-8 lg:flex lg:flex-col">
      <div class="relative z-10 space-y-5">
        <BrandLogo :light="true" subtitle="Control comercial" />
        <p class="max-w-xl text-sm leading-relaxed text-slate-300">
          Gestiona inventario, ventas, compras, clientes y proveedores desde una sola interfaz profesional.
        </p>
      </div>

      <div class="relative z-10 mt-8 grid gap-3 text-sm text-slate-200">
        <div class="rounded-xl border border-slate-700 bg-slate-800 px-4 py-3">
          Seguimiento de stock, costo y margen por producto.
        </div>
        <div class="rounded-xl border border-slate-700 bg-slate-800 px-4 py-3">
          Flujo de caja diario con historial y trazabilidad.
        </div>
        <div class="rounded-xl border border-slate-700 bg-slate-800 px-4 py-3">
          Operacion multiusuario con permisos por rol.
        </div>
      </div>

      <div class="relative z-10 mt-auto rounded-2xl bg-indigo-600 p-4 text-white shadow-lg shadow-indigo-500/30">
        <p class="text-xs uppercase tracking-[0.16em] text-white/80">{{ brandName }}</p>
        <p class="mt-1 text-sm text-white">Sistema de operacion comercial.</p>
      </div>
    </section>

    <section class="ui-card mx-auto w-full max-w-xl p-6 sm:p-8">
      <p class="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">Acceso seguro</p>
      <h2 class="mt-2 text-3xl font-display text-slate-800">{{ isSignUp ? 'Crear cuenta' : 'Ingresar al sistema' }}</h2>
      <p class="mt-2 text-sm text-slate-400">Solo personal autorizado de {{ brandName }}.</p>

      <div v-if="isSignUp" class="mt-5">
        <label class="ui-label">Nombre completo</label>
        <input v-model="fullName" type="text" class="ui-input" placeholder="Tu nombre" />
      </div>

      <div class="mt-4">
        <label class="ui-label">Correo</label>
        <input v-model="email" type="email" class="ui-input" placeholder="correo@tienda.com" />
      </div>

      <div class="mt-4">
        <label class="ui-label">Contrasena</label>
        <input v-model="password" type="password" class="ui-input" placeholder="********" />
      </div>

      <div class="mt-6 grid gap-3 sm:grid-cols-2">
        <button class="ui-btn" :disabled="loading" @click="submit">
          {{ loading ? 'Procesando...' : isSignUp ? 'Crear cuenta' : 'Ingresar' }}
        </button>
        <button class="ui-btn-secondary" @click="isSignUp = !isSignUp">
          {{ isSignUp ? 'Ya tengo cuenta' : 'Crear cuenta' }}
        </button>
      </div>

      <div
        v-if="message"
        class="mt-4"
        :class="message.toLowerCase().includes('error') ? 'ui-alert-error' : 'ui-alert'"
      >
        {{ message }}
      </div>
    </section>
  </div>
</template>
