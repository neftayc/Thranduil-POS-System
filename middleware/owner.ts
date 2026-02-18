export default defineNuxtRouteMiddleware(async () => {
  try {
    const { role } = await $fetch<{ role: string }>('/api/auth/me')
    if (role !== 'owner') {
      return navigateTo('/')
    }
  } catch {
    return navigateTo('/login')
  }
})
