import type { Config } from 'tailwindcss'
import colors from 'tailwindcss/colors'

export default {
  content: [
    './app.vue',
    './components/**/*.{vue,js,ts}',
    './layouts/**/*.vue',
    './pages/**/*.vue',
    './plugins/**/*.{js,ts}',
    './composables/**/*.{js,ts}',
    './utils/**/*.{js,ts}',
    './error.vue'
  ],
  theme: {
    extend: {
      colors: {
        brand: colors.indigo,
        sand: colors.amber
      },
      fontFamily: {
        sans: ['Plus Jakarta Sans', 'ui-sans-serif', 'system-ui'],
        display: ['Plus Jakarta Sans', 'ui-sans-serif', 'system-ui']
      },
      boxShadow: {
        soft: '0 18px 40px rgb(79 70 229 / 0.18)',
        card: '0 14px 28px rgb(79 70 229 / 0.15)'
      },
      borderRadius: {
        xl2: '1.25rem'
      }
    }
  }
} satisfies Config
