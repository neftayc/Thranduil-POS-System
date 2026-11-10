// Minimal stand-in for h3 so server modules can be loaded outside Nuxt in tests.
export const createError = input => Object.assign(new Error(input?.statusMessage || 'error'), input)
