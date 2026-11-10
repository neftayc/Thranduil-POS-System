export default defineNuxtConfig({
  ssr: false,
  devServer: {
    host: '0.0.0.0'
  },
  vite: {
    server: {
      allowedHosts: ['68bd-181-176-84-173.ngrok-free.app', 'localhost', '.ngrok-free.app']
    }
  },
  experimental: {
    appManifest: false
  },
  nitro: {
    // These are application modules, not Nitro startup modules.
    ignore: ['**/modules/**']
  },
  modules: ['@nuxtjs/tailwindcss'],
  css: ['~/assets/css/main.css'],
  runtimeConfig: {
    posAgentToken: process.env.POS_AGENT_TOKEN || '',
    // Encrypts the per-seller Supabase sessions opened from /vincular (min. 32 chars).
    posAgentSessionKey: process.env.POS_AGENT_SESSION_KEY || '',
    // Optional public origin for the /vincular link; defaults to the request origin.
    posAgentPublicUrl: process.env.POS_AGENT_PUBLIC_URL || '',
    posAgentReviewTtlHours: Number(process.env.POS_AGENT_REVIEW_TTL_HOURS || 48),
    posAgentModel: process.env.POS_AGENT_MODEL || 'gpt-4o-mini',
    posAgentEmbeddingModel: process.env.POS_AGENT_EMBEDDING_MODEL || 'text-embedding-3-small',
    // Validation-only mode for tests with real reads: never calls create_sale. Off by default.
    posAgentDryRun: ['1', 'true'].includes(String(process.env.POS_AGENT_DRY_RUN || '').trim().toLowerCase()),
    posAgentStorageDir: process.env.POS_AGENT_STORAGE_DIR || '.data/agent',
    supabaseServiceRole: process.env.SUPABASE_SERVICE_ROLE || '',
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    geminiApiKey: process.env.GEMINI_API_KEY || '',
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
