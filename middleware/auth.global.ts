export default defineNuxtRouteMiddleware(async (to) => {
  // /vincular authenticates with its own form (seller identification for Claude).
  if (to.path === '/login' || to.path === '/vincular') {
    return
  }

  try {
    await $fetch('/api/auth/me')
  } catch {
    return navigateTo('/login')
  }
})
