// Owner or manager (ventas por confirmar del agente de voz).
export default defineNuxtRouteMiddleware(async () => {
  try {
    const { role } = await $fetch<{ role: string }>('/api/auth/me')
    if (role !== 'owner' && role !== 'manager') {
      return navigateTo('/')
    }
  } catch {
    return navigateTo('/login')
  }
})
