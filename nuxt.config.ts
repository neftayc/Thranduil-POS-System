export default defineNuxtConfig({
  ssr: false,
  experimental: {
    appManifest: false
  },
  modules: ['@nuxtjs/tailwindcss'],
  css: ['~/assets/css/main.css'],
  runtimeConfig: {
    supabaseServiceRole: process.env.SUPABASE_SERVICE_ROLE || '',
    // Server-only Supabase credentials (do not expose to the client)
    supabaseUrl: process.env.SUPABASE_URL || process.env.NUXT_PUBLIC_SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || process.env.NUXT_PUBLIC_SUPABASE_ANON_KEY || '',
    public: {
      appName: process.env.NUXT_PUBLIC_APP_NAME || 'THRANDUIL'
    }
  },
  app: {
    head: {
      title: 'THRANDUIL',
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1' }
      ],
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/branding/thranduil-mark.svg' }
      ]
    }
  }
})
