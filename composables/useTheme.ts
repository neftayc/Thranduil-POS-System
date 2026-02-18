type ThemeId =
  | 'oceanic'
  | 'editorial'
  | 'nocturno'
  | 'natural'
  | 'azul-atlantico'
  | 'azul-niebla'
  | 'rosado-editorial'
  | 'rosado-neon-soft'

type ThemeOption = {
  id: ThemeId
  name: string
  description: string
  swatches: string[]
}

const STORAGE_KEY = 'papeleria:theme'
const DEFAULT_THEME: ThemeId = 'oceanic'

const THEMES: ThemeOption[] = [
  {
    id: 'oceanic',
    name: 'Oceanico Moderno',
    description: 'Look fresco y tecnologico para operacion diaria.',
    swatches: ['#0EA5A6', '#2563EB', '#F59E0B', '#102A43']
  },
  {
    id: 'editorial',
    name: 'Editorial Calido',
    description: 'Tono premium y artesanal con acentos calidos.',
    swatches: ['#C75C2A', '#7A8E5C', '#E9B44C', '#1F1A17']
  },
  {
    id: 'nocturno',
    name: 'Nocturno Sofisticado',
    description: 'Contraste alto con acento cian y violeta.',
    swatches: ['#22D3EE', '#A78BFA', '#F97316', '#0F172A']
  },
  {
    id: 'natural',
    name: 'Natural Contemporaneo',
    description: 'Ambiente claro, calmado y enfocado en lectura.',
    swatches: ['#3F7D58', '#6B8A7A', '#D4A373', '#F5F7F2']
  },
  {
    id: 'azul-atlantico',
    name: 'Azul Atlantico',
    description: 'Azul profundo, elegante y con acentos energicos.',
    swatches: ['#3A86FF', '#5BC0BE', '#FFBE0B', '#0B132B']
  },
  {
    id: 'azul-niebla',
    name: 'Azul Niebla',
    description: 'Estilo claro, limpio y moderno para trabajo diario.',
    swatches: ['#2563EB', '#38BDF8', '#0EA5A6', '#F4F8FF']
  },
  {
    id: 'rosado-editorial',
    name: 'Rosado Editorial',
    description: 'Look premium claro con tonos rosados suaves.',
    swatches: ['#E75480', '#C08497', '#F59EB0', '#FFF6FA']
  },
  {
    id: 'rosado-neon-soft',
    name: 'Rosado Neon Soft',
    description: 'Tema oscuro vibrante con rosa neon controlado.',
    swatches: ['#FF4FA3', '#F472B6', '#22D3EE', '#1A1020']
  }
]

const isThemeId = (value: string): value is ThemeId =>
  THEMES.some((theme) => theme.id === value)

export const useTheme = () => {
  const activeTheme = useState<ThemeId>('active-theme', () => DEFAULT_THEME)

  const applyThemeToDom = (themeId: ThemeId) => {
    if (!import.meta.client) return
    document.documentElement.setAttribute('data-theme', themeId)
  }

  const setTheme = (themeId: ThemeId) => {
    activeTheme.value = themeId
    if (!import.meta.client) return
    localStorage.setItem(STORAGE_KEY, themeId)
    applyThemeToDom(themeId)
  }

  const initTheme = () => {
    if (!import.meta.client) return

    const savedTheme = localStorage.getItem(STORAGE_KEY)
    if (savedTheme && isThemeId(savedTheme)) {
      activeTheme.value = savedTheme
    }

    applyThemeToDom(activeTheme.value)
  }

  watch(
    activeTheme,
    (themeId) => {
      applyThemeToDom(themeId)
    },
    { immediate: false }
  )

  return {
    themes: THEMES,
    activeTheme,
    setTheme,
    initTheme
  }
}
