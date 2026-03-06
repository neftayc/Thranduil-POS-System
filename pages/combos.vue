<script setup lang="ts">
import { matchesTokensAndFuzzy } from "~/utils/productSearch"

type ProductItem = {
  id: string
  sku: string | null
  name: string
  brand: string | null
  sale_price: number
  avg_cost: number
  stock_on_hand: number
  active: boolean
}

type ComboTone = "indigo" | "emerald" | "amber" | "rose"
type ComboPricingMode = "base_cost" | "plus10" | "absolute"
type ComboSaveState = "idle" | "pending" | "saving" | "saved" | "error"

type ComboLine = {
  id: string
  qtyPerCombo: number
  selectedProductId: string
  search: string
}

type ComboComponent = {
  id: string
  label: string
  lines: ComboLine[]
}

type ComboPlan = {
  id: string
  name: string
  note: string
  tone: ComboTone
  pricingMode: ComboPricingMode
  absolutePrice: number
  goalBags: number
  plannedBags: number
  components: ComboComponent[]
}

type ComboLineMetrics = {
  line: ComboLine
  product: ProductItem | null
  quantity: number
  availableUnits: number
  unitSalePrice: number
  unitCost: number
  lineCostTotal: number
  lineSaleTotal: number
  assignedTotal: number
  comboUnitPrice: number
  marginPct: number
}

type ComboComponentMetrics = {
  component: ComboComponent
  lines: ComboLineMetrics[]
  requiredUnits: number
  maxByStock: number
  ready: boolean
}

type ComboMetrics = {
  combo: ComboPlan
  components: ComboComponentMetrics[]
  flatLines: ComboLineMetrics[]
  comboPrice: number
  baseCostTotal: number
  saleReferenceTotal: number
  maxPossible: number
  unitMargin: number
  marginPct: number
  plannedBags: number
}

type StockUsageRow = {
  productId: string
  product: ProductItem
  requiredUnits: number
  availableUnits: number
  remainingUnits: number
  overflowUnits: number
  comboNames: string
}

const toneOptions: Array<{ value: ComboTone; label: string }> = [
  { value: "indigo", label: "Índigo" },
  { value: "emerald", label: "Esmeralda" },
  { value: "amber", label: "Ámbar" },
  { value: "rose", label: "Rosa" },
]

let comboSequence = 0
let componentSequence = 0
let lineSequence = 0

const nextComboId = () => {
  comboSequence += 1
  return `combo-${comboSequence}`
}

const nextComponentId = () => {
  componentSequence += 1
  return `component-${componentSequence}`
}

const nextLineId = () => {
  lineSequence += 1
  return `line-${lineSequence}`
}

const createLine = (qtyPerCombo = 1): ComboLine => ({
  id: nextLineId(),
  qtyPerCombo,
  selectedProductId: "",
  search: "",
})

const createComponent = (label = "Componente", qtyPerCombo = 1): ComboComponent => ({
  id: nextComponentId(),
  label,
  lines: [createLine(qtyPerCombo)],
})

const createCombo = (
  partial?: Partial<Omit<ComboPlan, "id" | "components">> & {
    components?: Array<{ label: string; qtyPerCombo: number }>
  },
): ComboPlan => ({
  id: nextComboId(),
  name: partial?.name || `Nuevo combo ${comboSequence}`,
  note: partial?.note || "",
  tone: partial?.tone || "indigo",
  pricingMode: partial?.pricingMode || "plus10",
  absolutePrice: Number(partial?.absolutePrice || 0),
  goalBags: Number(partial?.goalBags || 0),
  plannedBags: Number(partial?.plannedBags || 0),
  components:
    partial?.components?.length
      ? partial.components.map((item) =>
          createComponent(item.label, Number(item.qtyPerCombo || 1)),
        )
      : [createComponent("Componente", 1)],
})

const buildStarterCombos = (): ComboPlan[] => [
  createCombo({
    name: "Combo Arranque Escolar",
    note: "3 cuadernos + 2 lapiceros + 1 lápiz + 1 borrador",
    tone: "indigo",
    pricingMode: "absolute",
    absolutePrice: 10,
    goalBags: 30,
    components: [
      { label: "Cuaderno", qtyPerCombo: 3 },
      { label: "Lapicero", qtyPerCombo: 2 },
      { label: "Lápiz", qtyPerCombo: 1 },
      { label: "Borrador", qtyPerCombo: 1 },
    ],
  }),
  createCombo({
    name: "Combo Arte en Remate",
    note: "1 colores x12 + 1 block/cartulinas + 1 regla + 1 tajador",
    tone: "emerald",
    pricingMode: "absolute",
    absolutePrice: 10,
    goalBags: 18,
    components: [
      { label: "Caja de colores", qtyPerCombo: 1 },
      { label: "Block/cartulinas", qtyPerCombo: 1 },
      { label: "Regla 30 cm", qtyPerCombo: 1 },
      { label: "Tajador", qtyPerCombo: 1 },
    ],
  }),
  createCombo({
    name: "Combo Útiles de Rescate",
    note: "4 lapiceros + 2 lápices + 1 liquid paper + 1 goma/silicona",
    tone: "amber",
    pricingMode: "absolute",
    absolutePrice: 5,
    goalBags: 25,
    components: [
      { label: "Lapicero", qtyPerCombo: 4 },
      { label: "Lápiz", qtyPerCombo: 2 },
      { label: "Liquid paper", qtyPerCombo: 1 },
      { label: "Goma/silicona", qtyPerCombo: 1 },
    ],
  }),
  createCombo({
    name: "Paga 3, Lleva 4 (Cuadernos)",
    note: "Paquete de 4 cuadernos en remate",
    tone: "rose",
    pricingMode: "absolute",
    absolutePrice: 15,
    goalBags: 15,
    components: [{ label: "Cuaderno", qtyPerCombo: 4 }],
  }),
]

const loading = ref(false)
const message = ref("")
const products = ref<ProductItem[]>([])
const comboPlans = ref<ComboPlan[]>(buildStarterCombos())
const activeSearchLineId = ref("")
const activeComboId = ref("")
const comboSearch = ref("")
const comboSaveState = ref<ComboSaveState>("idle")
const comboLastSavedAt = ref("")
const comboSaveMode = ref<"remote" | "local">("remote")
const combosReadyForAutosave = ref(false)
const isHydratingCombos = ref(false)
let comboAutosaveTimer: ReturnType<typeof setTimeout> | null = null
const LOCAL_COMBO_STORAGE_KEY = "papeleria_combo_workspace_v1"

const numberFormatter = new Intl.NumberFormat("es-PE", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
})

const moneyFormatter = new Intl.NumberFormat("es-PE", {
  style: "currency",
  currency: "PEN",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

const toNumber = (value: any) => {
  const num = Number(value)
  return Number.isFinite(num) ? num : 0
}

const toMoney = (value: any) => Number(Math.max(0, toNumber(value)).toFixed(2))
const toUnits = (value: any, min = 0) => Math.max(min, Math.trunc(toNumber(value)))
const roundMoney = (value: number) => Number(value.toFixed(2))

const formatMoney = (value: number) => moneyFormatter.format(toNumber(value))
const formatUnits = (value: number) => numberFormatter.format(toUnits(value))

const getErrorMessage = (err: any, fallback: string) =>
  err?.data?.statusMessage || err?.message || fallback

const formatDateTime = (value: string) => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  return new Intl.DateTimeFormat("es-PE", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date)
}

const comboSaveLabel = computed(() => {
  if (comboSaveState.value === "saving") return "Guardando cambios..."
  if (comboSaveState.value === "pending") return "Cambios pendientes de guardar"
  if (comboSaveState.value === "saved") {
    const sourceLabel = comboSaveMode.value === "local" ? " (local)" : ""
    if (comboLastSavedAt.value) return `Guardado${sourceLabel}: ${comboLastSavedAt.value}`
    return `Cambios guardados${sourceLabel}`
  }
  if (comboSaveState.value === "error") return "Error al guardar los combos"
  return "Aún no se guardaron cambios"
})

const pricingModeLabel = (mode: ComboPricingMode) => {
  if (mode === "base_cost") return "Base compra"
  if (mode === "plus10") return "Compra +10%"
  return "Precio absoluto"
}

const toneClasses = (tone: ComboTone) => {
  if (tone === "indigo") {
    return {
      border: "border-indigo-100",
      card: "from-indigo-50 to-white",
      chip: "bg-indigo-50 text-indigo-700",
      strong: "text-indigo-600",
      header: "bg-indigo-600",
      soft: "bg-indigo-50/40",
    }
  }

  if (tone === "emerald") {
    return {
      border: "border-emerald-100",
      card: "from-emerald-50 to-white",
      chip: "bg-emerald-50 text-emerald-700",
      strong: "text-emerald-600",
      header: "bg-emerald-600",
      soft: "bg-emerald-50/40",
    }
  }

  if (tone === "amber") {
    return {
      border: "border-amber-100",
      card: "from-amber-50 to-white",
      chip: "bg-amber-50 text-amber-700",
      strong: "text-amber-600",
      header: "bg-amber-500",
      soft: "bg-amber-50/40",
    }
  }

  return {
    border: "border-rose-100",
    card: "from-rose-50 to-white",
    chip: "bg-rose-50 text-rose-700",
    strong: "text-rose-600",
    header: "bg-rose-500",
    soft: "bg-rose-50/40",
  }
}

const productMap = computed(() => {
  const map = new Map<string, ProductItem>()
  products.value.forEach((product) => map.set(product.id, product))
  return map
})

const activeProducts = computed(() =>
  products.value
    .filter((product) => product.active !== false)
    .sort((a, b) => {
      const byStock = toUnits(b.stock_on_hand) - toUnits(a.stock_on_hand)
      if (byStock !== 0) return byStock
      return String(a.name || "").localeCompare(String(b.name || ""), "es")
    }),
)

const productLabel = (product: ProductItem) => {
  const fields = [product.name, product.brand || "", product.sku || ""]
    .map((item) => String(item || "").trim())
    .filter(Boolean)
  return fields.join(" · ")
}

const productHaystack = (product: ProductItem) =>
  `${product.name || ""} ${product.brand || ""} ${product.sku || ""}`

const resolveComboPrice = (
  combo: ComboPlan,
  baseCostTotal: number,
) => {
  if (combo.pricingMode === "base_cost") return roundMoney(baseCostTotal)
  if (combo.pricingMode === "plus10") return roundMoney(baseCostTotal * 1.1)
  return roundMoney(combo.absolutePrice)
}

const getLineSuggestions = (component: ComboComponent, line: ComboLine) => {
  const searchTerm = String(line.search || "").trim()
  const fallbackTerm = String(component.label || "").trim()
  const term = searchTerm || fallbackTerm

  let rows = activeProducts.value
  if (term) rows = rows.filter((product) => matchesTokensAndFuzzy(term, productHaystack(product)))

  if (!rows.length && searchTerm && fallbackTerm && searchTerm !== fallbackTerm) {
    rows = activeProducts.value.filter((product) =>
      matchesTokensAndFuzzy(fallbackTerm, productHaystack(product)),
    )
  }

  const selected = productMap.value.get(line.selectedProductId)
  if (selected && !rows.some((product) => product.id === selected.id)) {
    rows = [selected, ...rows]
  }

  return rows.slice(0, 10)
}

const openLineSearch = (lineId: string) => {
  activeSearchLineId.value = lineId
}

const closeLineSearchLater = (lineId: string) => {
  setTimeout(() => {
    if (activeSearchLineId.value === lineId) activeSearchLineId.value = ""
  }, 120)
}

const onLineSearchInput = (line: ComboLine) => {
  const selected = productMap.value.get(line.selectedProductId)
  if (selected && line.search.trim() !== productLabel(selected)) {
    line.selectedProductId = ""
  }
  activeSearchLineId.value = line.id
}

const selectLineProduct = (line: ComboLine, product: ProductItem) => {
  line.selectedProductId = product.id
  line.search = productLabel(product)
  activeSearchLineId.value = ""
}

const clearLineProduct = (line: ComboLine) => {
  line.selectedProductId = ""
  line.search = ""
  activeSearchLineId.value = line.id
}

const sanitizeLine = (line: ComboLine) => {
  line.qtyPerCombo = Math.max(1, toUnits(line.qtyPerCombo, 1))
}

const sanitizeComponent = (component: ComboComponent) => {
  component.label = String(component.label || "").trim() || "Componente"
  if (!component.lines.length) component.lines.push(createLine(1))
  component.lines.forEach((line) => sanitizeLine(line))
}

const sanitizeCombo = (combo: ComboPlan) => {
  combo.name = String(combo.name || "").trim() || "Nuevo combo"
  combo.note = String(combo.note || "")
  combo.absolutePrice = toMoney(combo.absolutePrice)
  combo.goalBags = toUnits(combo.goalBags)
  combo.plannedBags = toUnits(combo.plannedBags)
  combo.components.forEach((component) => sanitizeComponent(component))

  const maxPossible = buildComboMetrics(combo).maxPossible
  if (combo.plannedBags > maxPossible) combo.plannedBags = maxPossible
}

const syncSequencesFromCombos = (combos: ComboPlan[]) => {
  const parseSuffix = (value: string, prefix: string) => {
    const match = new RegExp(`^${prefix}-(\\d+)$`).exec(String(value || ""))
    return match ? Number(match[1]) : 0
  }

  const maxCombo = combos.reduce((max, combo) => Math.max(max, parseSuffix(combo.id, "combo")), 0)
  const maxComponent = combos.reduce((maxComponentId, combo) => {
    const componentMax = combo.components.reduce(
      (maxByCombo, component) => Math.max(maxByCombo, parseSuffix(component.id, "component")),
      0,
    )
    return Math.max(maxComponentId, componentMax)
  }, 0)
  const maxLine = combos.reduce((maxLineId, combo) => {
    const lineMax = combo.components.reduce((maxByCombo, component) => {
      const byComponent = component.lines.reduce(
        (maxByComponent, line) => Math.max(maxByComponent, parseSuffix(line.id, "line")),
        0,
      )
      return Math.max(maxByCombo, byComponent)
    }, 0)
    return Math.max(maxLineId, lineMax)
  }, 0)

  comboSequence = Math.max(comboSequence, maxCombo)
  componentSequence = Math.max(componentSequence, maxComponent)
  lineSequence = Math.max(lineSequence, maxLine)
}

const serializeComboPlans = () =>
  comboPlans.value.map((combo) => ({
    id: combo.id,
    name: String(combo.name || "").trim(),
    note: String(combo.note || ""),
    tone: combo.tone,
    pricingMode: combo.pricingMode,
    absolutePrice: toMoney(combo.absolutePrice),
    goalBags: toUnits(combo.goalBags),
    plannedBags: toUnits(combo.plannedBags),
    components: combo.components.map((component) => ({
      id: component.id,
      label: String(component.label || "").trim() || "Componente",
      lines: component.lines.map((line) => ({
        id: line.id,
        qtyPerCombo: Math.max(1, toUnits(line.qtyPerCombo, 1)),
        selectedProductId: String(line.selectedProductId || ""),
        search: String(line.search || ""),
      })),
    })),
  }))

const saveComboPlansToLocal = (payload: any[]) => {
  if (!import.meta.client) return false
  try {
    localStorage.setItem(LOCAL_COMBO_STORAGE_KEY, JSON.stringify(payload))
    return true
  } catch {
    return false
  }
}

const loadComboPlansFromLocal = (): any[] | null => {
  if (!import.meta.client) return null
  try {
    const raw = localStorage.getItem(LOCAL_COMBO_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

const hydrateComboPlans = (input: any): ComboPlan[] => {
  if (!Array.isArray(input)) return []

  return input.map((rawCombo: any, index: number) => {
    const combo = createCombo({
      name: String(rawCombo?.name || `Nuevo combo ${index + 1}`),
      note: String(rawCombo?.note || ""),
      tone: rawCombo?.tone,
      pricingMode: rawCombo?.pricingMode,
      absolutePrice: toMoney(rawCombo?.absolutePrice),
      goalBags: toUnits(rawCombo?.goalBags),
      plannedBags: toUnits(rawCombo?.plannedBags),
      components: [],
    })

    if (typeof rawCombo?.id === "string" && rawCombo.id.trim()) {
      combo.id = rawCombo.id.trim()
    }

    const rawComponents = Array.isArray(rawCombo?.components) ? rawCombo.components : []
    combo.components = rawComponents.length
      ? rawComponents.map((rawComponent: any) => {
          const component = createComponent(String(rawComponent?.label || "Componente"), 1)

          if (typeof rawComponent?.id === "string" && rawComponent.id.trim()) {
            component.id = rawComponent.id.trim()
          }

          const rawLines = Array.isArray(rawComponent?.lines) ? rawComponent.lines : []
          component.lines = rawLines.length
            ? rawLines.map((rawLine: any) => {
                const line = createLine(Math.max(1, toUnits(rawLine?.qtyPerCombo, 1)))
                if (typeof rawLine?.id === "string" && rawLine.id.trim()) {
                  line.id = rawLine.id.trim()
                }
                line.selectedProductId = String(rawLine?.selectedProductId || "")
                line.search = String(rawLine?.search || "")
                sanitizeLine(line)
                return line
              })
            : [createLine(1)]

          sanitizeComponent(component)
          return component
        })
      : [createComponent("Componente", 1)]

    if (!["indigo", "emerald", "amber", "rose"].includes(combo.tone)) combo.tone = "indigo"
    if (!["base_cost", "plus10", "absolute"].includes(combo.pricingMode)) combo.pricingMode = "plus10"
    sanitizeCombo(combo)
    return combo
  })
}

const persistComboPlans = async () => {
  if (isHydratingCombos.value) return
  if (comboAutosaveTimer) {
    clearTimeout(comboAutosaveTimer)
    comboAutosaveTimer = null
  }

  comboSaveState.value = "saving"
  message.value = ""

  const payload = serializeComboPlans()
  const savedLocal = saveComboPlansToLocal(payload)

  try {
    const res = await $fetch<{ ok: boolean; updated_at: string | null }>("/api/combos/plans", {
      method: "PUT",
      body: { combos: payload },
    })

    comboSaveMode.value = "remote"
    comboSaveState.value = "saved"
    comboLastSavedAt.value = res.updated_at ? formatDateTime(res.updated_at) : formatDateTime(new Date().toISOString())
  } catch (err: any) {
    if (savedLocal) {
      comboSaveMode.value = "local"
      comboSaveState.value = "saved"
      comboLastSavedAt.value = formatDateTime(new Date().toISOString())
      return
    }

    comboSaveState.value = "error"
    message.value = getErrorMessage(err, "No se pudieron guardar los combos.")
  }
}

const queueComboAutosave = () => {
  if (!combosReadyForAutosave.value || isHydratingCombos.value) return

  comboSaveState.value = "pending"
  if (comboAutosaveTimer) clearTimeout(comboAutosaveTimer)
  comboAutosaveTimer = setTimeout(() => {
    persistComboPlans()
  }, 700)
}

const loadSavedComboPlans = async () => {
  message.value = ""
  try {
    const res = await $fetch<{ combos: any[] | null; updated_at: string | null }>("/api/combos/plans")
    if (!Array.isArray(res.combos) || !res.combos.length) {
      const localCombos = loadComboPlansFromLocal()
      if (Array.isArray(localCombos) && localCombos.length) {
        isHydratingCombos.value = true
        comboPlans.value = hydrateComboPlans(localCombos)
        if (!comboPlans.value.length) comboPlans.value = buildStarterCombos()
        syncSequencesFromCombos(comboPlans.value)
        comboSaveMode.value = "local"
        comboSaveState.value = "saved"
        comboLastSavedAt.value = ""
      } else {
        comboSaveState.value = "idle"
        syncSequencesFromCombos(comboPlans.value)
      }
      return
    }

    isHydratingCombos.value = true
    comboPlans.value = hydrateComboPlans(res.combos)
    if (!comboPlans.value.length) comboPlans.value = buildStarterCombos()
    syncSequencesFromCombos(comboPlans.value)

    comboSaveMode.value = "remote"
    comboLastSavedAt.value = res.updated_at ? formatDateTime(res.updated_at) : ""
    comboSaveState.value = "saved"
  } catch (err: any) {
    const localCombos = loadComboPlansFromLocal()
    if (Array.isArray(localCombos) && localCombos.length) {
      isHydratingCombos.value = true
      comboPlans.value = hydrateComboPlans(localCombos)
      if (!comboPlans.value.length) comboPlans.value = buildStarterCombos()
      syncSequencesFromCombos(comboPlans.value)
      comboSaveMode.value = "local"
      comboSaveState.value = "saved"
      comboLastSavedAt.value = ""
    } else {
      comboSaveState.value = "error"
      message.value = getErrorMessage(err, "No se pudieron cargar los combos guardados.")
    }
  } finally {
    isHydratingCombos.value = false
  }
}

const addCombo = () => {
  const combo = createCombo()
  comboPlans.value.push(combo)
  activeComboId.value = combo.id
}

const removeCombo = (comboId: string) => {
  comboPlans.value = comboPlans.value.filter((combo) => combo.id !== comboId)

  if (!comboPlans.value.length) {
    const combo = createCombo()
    comboPlans.value.push(combo)
  }

  if (activeComboId.value === comboId) activeComboId.value = ""
}

const addComponent = (combo: ComboPlan) => {
  combo.components.push(createComponent("Componente", 1))
}

const removeComponent = (combo: ComboPlan, componentId: string) => {
  if (combo.components.length <= 1) {
    combo.components = [createComponent("Componente", 1)]
    sanitizeCombo(combo)
    return
  }

  combo.components = combo.components.filter((component) => component.id !== componentId)
  sanitizeCombo(combo)
}

const addLine = (component: ComboComponent) => {
  component.lines.push(createLine(1))
}

const removeLine = (component: ComboComponent, lineId: string) => {
  if (component.lines.length <= 1) {
    component.lines = [createLine(1)]
    return
  }

  component.lines = component.lines.filter((line) => line.id !== lineId)
}

const useStarterCombos = () => {
  comboPlans.value = buildStarterCombos()
  activeComboId.value = ""
}

const clearSelections = () => {
  comboPlans.value.forEach((combo) => {
    combo.plannedBags = 0
    combo.components.forEach((component) => {
      component.lines.forEach((line) => {
        line.selectedProductId = ""
        line.search = ""
      })
    })
  })
}

const openComboModal = (comboId: string) => {
  activeComboId.value = comboId
}

const closeComboModal = () => {
  activeComboId.value = ""
  activeSearchLineId.value = ""
}

const buildComboMetrics = (combo: ComboPlan): ComboMetrics => {
  const componentRows: ComboComponentMetrics[] = combo.components.map((component) => {
    const lineRows: ComboLineMetrics[] = component.lines.map((line) => {
      const quantity = Math.max(1, toUnits(line.qtyPerCombo, 1))
      const product = productMap.value.get(line.selectedProductId) || null
      const availableUnits = product ? toUnits(product.stock_on_hand) : 0
      const unitSalePrice = product ? toMoney(product.sale_price) : 0
      const fallbackCost = product ? toMoney(product.sale_price) : 0
      const unitCost = product ? toMoney(product.avg_cost > 0 ? product.avg_cost : fallbackCost) : 0

      return {
        line,
        product,
        quantity,
        availableUnits,
        unitSalePrice,
        unitCost,
        lineCostTotal: roundMoney(quantity * unitCost),
        lineSaleTotal: roundMoney(quantity * unitSalePrice),
        assignedTotal: 0,
        comboUnitPrice: 0,
        marginPct: 0,
      }
    })

    const selectedLines = lineRows.filter((row) => Boolean(row.product))
    const requiredUnits = selectedLines.reduce((sum, row) => sum + row.quantity, 0)
    const ready = selectedLines.length > 0

    const requiredByProduct = new Map<string, { required: number; available: number }>()
    selectedLines.forEach((row) => {
      if (!row.product) return

      const current = requiredByProduct.get(row.product.id) || {
        required: 0,
        available: row.availableUnits,
      }
      current.required += row.quantity
      requiredByProduct.set(row.product.id, current)
    })

    const maxByStock = ready
      ? Math.min(
          ...Array.from(requiredByProduct.values()).map((item) =>
            item.required > 0 ? Math.floor(item.available / item.required) : 0,
          ),
        )
      : 0

    return {
      component,
      lines: lineRows,
      requiredUnits,
      maxByStock,
      ready,
    }
  })

  const flatLines = componentRows.flatMap((component) =>
    component.lines.filter((line) => Boolean(line.product)),
  )

  const baseCostTotal = roundMoney(
    flatLines.reduce((sum, row) => sum + row.lineCostTotal, 0),
  )
  const saleReferenceTotal = roundMoney(
    flatLines.reduce((sum, row) => sum + row.lineSaleTotal, 0),
  )

  const comboPrice = resolveComboPrice(combo, baseCostTotal)

  const useSaleReference = combo.pricingMode === "absolute" && saleReferenceTotal > 0
  const weightedRows = flatLines.map((row, index) => ({
    row,
    index,
    weight: useSaleReference ? row.lineSaleTotal : row.lineCostTotal,
  }))
  const totalWeight = weightedRows.reduce((sum, item) => sum + item.weight, 0)

  if (totalWeight > 0 && comboPrice > 0) {
    const targetCents = Math.round(comboPrice * 100)
    const allocations = weightedRows.map((item) => {
      const exact = (targetCents * item.weight) / totalWeight
      const cents = Math.floor(exact)
      return {
        ...item,
        cents,
        fraction: exact - cents,
      }
    })

    const assignedCents = allocations.reduce((sum, item) => sum + item.cents, 0)
    let remainder = targetCents - assignedCents
    allocations.sort((a, b) => {
      if (b.fraction !== a.fraction) return b.fraction - a.fraction
      return a.index - b.index
    })

    let cursor = 0
    while (remainder > 0 && allocations.length > 0) {
      allocations[cursor % allocations.length].cents += 1
      remainder -= 1
      cursor += 1
    }

    allocations.sort((a, b) => a.index - b.index)
    allocations.forEach((item) => {
      item.row.assignedTotal = roundMoney(item.cents / 100)
    })
  } else {
    flatLines.forEach((row) => {
      row.assignedTotal = 0
    })
  }

  flatLines.forEach((row) => {
    row.comboUnitPrice = row.quantity > 0 ? roundMoney(row.assignedTotal / row.quantity) : 0
    row.marginPct =
      row.lineCostTotal > 0
        ? roundMoney(((row.assignedTotal - row.lineCostTotal) / row.lineCostTotal) * 100)
        : 0
  })

  const readyComponents = componentRows.filter((row) => row.ready)
  const maxPossible = readyComponents.length
    ? Math.min(...readyComponents.map((row) => row.maxByStock))
    : 0

  const unitMargin = roundMoney(comboPrice - baseCostTotal)
  const marginPct = comboPrice > 0 ? roundMoney((unitMargin / comboPrice) * 100) : 0
  const plannedBags = Math.min(toUnits(combo.plannedBags), maxPossible)

  return {
    combo,
    components: componentRows,
    flatLines,
    comboPrice,
    baseCostTotal,
    saleReferenceTotal,
    maxPossible,
    unitMargin,
    marginPct,
    plannedBags,
  }
}

const comboMetrics = computed(() => comboPlans.value.map((combo) => buildComboMetrics(combo)))

const filteredComboMetrics = computed(() => {
  const term = String(comboSearch.value || "").trim()
  if (!term) return comboMetrics.value

  return comboMetrics.value.filter((metric) => {
    const checklist = comboChecklist(metric).join(" ")
    const haystack = `${metric.combo.name} ${metric.combo.note} ${checklist}`
    return matchesTokensAndFuzzy(term, haystack)
  })
})

const activeCombo = computed(
  () => comboPlans.value.find((combo) => combo.id === activeComboId.value) || null,
)

const activeComboMetric = computed(() => {
  if (!activeCombo.value) return null
  return buildComboMetrics(activeCombo.value)
})

const comboChecklist = (metric: ComboMetrics) => {
  const result: string[] = []
  const seen = new Set<string>()

  metric.flatLines.forEach((row) => {
    if (!row.product) return
    if (seen.has(row.product.id)) return
    seen.add(row.product.id)
    result.push(row.product.name)
  })

  metric.components.forEach((componentRow) => {
    const hasSelected = componentRow.lines.some((row) => Boolean(row.product))
    if (hasSelected) return

    const fallbackLabel = String(componentRow.component.label || "").trim()
    if (!fallbackLabel) return
    if (result.includes(`Pendiente: ${fallbackLabel}`)) return
    result.push(`Pendiente: ${fallbackLabel}`)
  })

  return result
}

const totals = computed(() => {
  const totalBags = comboMetrics.value.reduce((sum, metric) => sum + metric.plannedBags, 0)
  const revenue = roundMoney(
    comboMetrics.value.reduce((sum, metric) => sum + metric.plannedBags * metric.comboPrice, 0),
  )
  const estimatedCost = roundMoney(
    comboMetrics.value.reduce(
      (sum, metric) => sum + metric.plannedBags * metric.baseCostTotal,
      0,
    ),
  )
  const margin = roundMoney(revenue - estimatedCost)
  const marginPct = revenue > 0 ? roundMoney((margin / revenue) * 100) : 0

  return {
    totalBags,
    revenue,
    estimatedCost,
    margin,
    marginPct,
  }
})

const stockUsageRows = computed<StockUsageRow[]>(() => {
  const usage = new Map<
    string,
    { product: ProductItem; requiredUnits: number; comboNames: Set<string> }
  >()

  comboMetrics.value.forEach((metric) => {
    if (metric.plannedBags <= 0) return

    metric.flatLines.forEach((line) => {
      if (!line.product) return

      const required = metric.plannedBags * line.quantity
      const current = usage.get(line.product.id) || {
        product: line.product,
        requiredUnits: 0,
        comboNames: new Set<string>(),
      }

      current.requiredUnits += required
      current.comboNames.add(metric.combo.name)
      usage.set(line.product.id, current)
    })
  })

  return Array.from(usage.values())
    .map((row) => {
      const availableUnits = toUnits(row.product.stock_on_hand)
      const remainingUnits = availableUnits - row.requiredUnits
      const overflowUnits = Math.max(0, -remainingUnits)
      return {
        productId: row.product.id,
        product: row.product,
        requiredUnits: row.requiredUnits,
        availableUnits,
        remainingUnits,
        overflowUnits,
        comboNames: Array.from(row.comboNames).join(", "),
      }
    })
    .sort((a, b) => {
      if (a.overflowUnits !== b.overflowUnits) return b.overflowUnits - a.overflowUnits
      return b.requiredUnits - a.requiredUnits
    })
})

const stockConflicts = computed(() => stockUsageRows.value.filter((row) => row.overflowUnits > 0))

const clearInvalidSelections = () => {
  const availableIds = new Set(products.value.map((product) => product.id))

  comboPlans.value.forEach((combo) => {
    combo.components.forEach((component) => {
      component.lines.forEach((line) => {
        if (line.selectedProductId && !availableIds.has(line.selectedProductId)) {
          line.selectedProductId = ""
          line.search = ""
        }
      })
    })
  })
}

const applySuggestedPlan = () => {
  comboPlans.value.forEach((combo) => {
    const maxPossible = buildComboMetrics(combo).maxPossible
    combo.plannedBags = Math.min(toUnits(combo.goalBags), maxPossible)
  })
}

const applyMaxPlan = () => {
  comboPlans.value.forEach((combo) => {
    combo.plannedBags = buildComboMetrics(combo).maxPossible
  })
}

const loadProducts = async () => {
  loading.value = true
  message.value = ""

  try {
    const res = await $fetch<{ products: any[] }>("/api/products/page")
    products.value = (res.products || []).map((item: any) => ({
      id: String(item.id || ""),
      sku: item.sku || null,
      name: String(item.name || ""),
      brand: item.brand || null,
      sale_price: toMoney(item.sale_price),
      avg_cost: toMoney(item.avg_cost),
      stock_on_hand: toUnits(item.stock_on_hand),
      active: item.active !== false,
    }))

    clearInvalidSelections()

    comboPlans.value.forEach((combo) => {
      combo.components.forEach((component) => {
        component.lines.forEach((line) => {
          const selected = productMap.value.get(line.selectedProductId)
          if (selected && !line.search.trim()) line.search = productLabel(selected)
        })
      })
      sanitizeCombo(combo)
    })
  } catch (err: any) {
    message.value = getErrorMessage(err, "No se pudieron cargar los productos.")
  } finally {
    loading.value = false
  }
}

watch(
  comboPlans,
  () => {
    queueComboAutosave()
  },
  { deep: true },
)

onMounted(async () => {
  await loadProducts()
  await loadSavedComboPlans()

  comboPlans.value.forEach((combo) => {
    combo.components.forEach((component) => {
      component.lines.forEach((line) => {
        const selected = productMap.value.get(line.selectedProductId)
        if (selected && !line.search.trim()) line.search = productLabel(selected)
      })
    })
    sanitizeCombo(combo)
  })

  syncSequencesFromCombos(comboPlans.value)
  combosReadyForAutosave.value = true
})

onBeforeUnmount(() => {
  if (comboAutosaveTimer) {
    clearTimeout(comboAutosaveTimer)
    comboAutosaveTimer = null
  }
})
</script>

<template>
  <div class="space-y-6">
    <section class="ui-card">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 class="ui-heading">Combos</h1>
          <p class="ui-subtitle">
            Cada combo está en una tarjeta. Haz click para gestionar productos y
            precios dentro del modal.
          </p>
        </div>

      </div>

      <div class="mt-4 grid grid-cols-1 gap-3 xl:grid-cols-[1fr_360px]">
        <div class="flex flex-wrap gap-2">
          <button class="ui-btn" @click="addCombo">+ Agregar combo</button>
          <button class="ui-btn-secondary" :disabled="loading" @click="useStarterCombos">
            Cargar combos base
          </button>
          <button class="ui-btn-secondary" :disabled="loading" @click="loadProducts">
            {{ loading ? "Cargando..." : "Recargar stock" }}
          </button>
          <button class="ui-btn-secondary" :disabled="loading" @click="applySuggestedPlan">
            Plan sugerido
          </button>
          <button class="ui-btn-secondary" :disabled="loading" @click="applyMaxPlan">
            Usar máximo posible
          </button>
          <button class="ui-btn-secondary" :disabled="loading" @click="clearSelections">
            Limpiar selección
          </button>
          <button
            class="ui-btn-secondary"
            :disabled="loading || comboSaveState === 'saving'"
            @click="persistComboPlans"
          >
            {{ comboSaveState === "saving" ? "Guardando..." : "Guardar ahora" }}
          </button>
        </div>

        <div class="relative">
          <input
            v-model="comboSearch"
            type="text"
            class="ui-input pl-10"
            placeholder="Buscar combo, nota o producto"
          />
          <svg
            class="pointer-events-none absolute left-3 top-3 h-5 w-5 text-slate-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M21 21l-5.2-5.2m2.2-4.8a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <p
            class="mt-1 text-xs font-semibold"
            :class="
              comboSaveState === 'error'
                ? 'text-rose-600'
                : comboSaveState === 'saved'
                  ? 'text-emerald-600'
                  : 'text-slate-500'
            "
          >
            {{ comboSaveLabel }}
          </p>
        </div>
      </div>

      <div class="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <article class="rounded-xl border border-gray-100 bg-slate-50 p-4">
          <p class="text-xs font-bold uppercase tracking-wider text-slate-400">Bolsas a preparar</p>
          <p class="mt-2 text-2xl font-bold text-slate-800">{{ formatUnits(totals.totalBags) }}</p>
        </article>

        <article class="rounded-xl border border-gray-100 bg-slate-50 p-4">
          <p class="text-xs font-bold uppercase tracking-wider text-slate-400">Ingreso proyectado</p>
          <p class="mt-2 text-2xl font-bold text-slate-800">{{ formatMoney(totals.revenue) }}</p>
        </article>

        <article class="rounded-xl border border-gray-100 bg-slate-50 p-4">
          <p class="text-xs font-bold uppercase tracking-wider text-slate-400">Costo estimado</p>
          <p class="mt-2 text-2xl font-bold text-slate-800">{{ formatMoney(totals.estimatedCost) }}</p>
        </article>

        <article class="rounded-xl border border-gray-100 bg-slate-50 p-4">
          <p class="text-xs font-bold uppercase tracking-wider text-slate-400">Margen estimado</p>
          <p class="mt-2 text-2xl font-bold" :class="totals.margin >= 0 ? 'text-emerald-600' : 'text-rose-600'">
            {{ formatMoney(totals.margin) }}
          </p>
          <p class="mt-1 text-xs font-semibold text-slate-500">{{ totals.marginPct.toFixed(2) }}%</p>
        </article>
      </div>
    </section>

    <div v-if="message" class="ui-alert-error">{{ message }}</div>

    <section class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      <article
        v-for="(metric, index) in filteredComboMetrics"
        :key="metric.combo.id"
        class="group cursor-pointer overflow-hidden rounded-2xl border-2 bg-gradient-to-b p-4 shadow-sm transition hover:-translate-y-1 hover:shadow-lg"
        :class="[toneClasses(metric.combo.tone).border, toneClasses(metric.combo.tone).card]"
        @click="openComboModal(metric.combo.id)"
      >
        <div class="-mx-4 -mt-4 mb-3 h-1.5" :class="toneClasses(metric.combo.tone).header" />

        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <p class="text-xs font-black uppercase tracking-wider text-slate-500">Combo {{ index + 1 }}</p>
            <h3 class="truncate text-lg font-extrabold text-slate-800">{{ metric.combo.name || "Sin nombre" }}</h3>
            <p class="mt-1 truncate text-xs font-semibold text-slate-500">{{ metric.combo.note || "Sin descripción" }}</p>
          </div>

          <button
            class="rounded-lg border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] font-bold text-rose-700 transition hover:bg-rose-100"
            @click.stop="removeCombo(metric.combo.id)"
          >
            Eliminar
          </button>
        </div>

        <div class="mt-3 grid grid-cols-2 gap-2">
          <article class="rounded-lg border border-white/80 bg-white/80 p-2">
            <p class="text-[10px] font-black uppercase tracking-wide text-slate-400">Precio combo</p>
            <p class="mt-1 text-lg font-black text-slate-800">{{ formatMoney(metric.comboPrice) }}</p>
          </article>

          <article class="rounded-lg border border-white/80 bg-white/80 p-2">
            <p class="text-[10px] font-black uppercase tracking-wide text-slate-400">Margen unit.</p>
            <p class="mt-1 text-lg font-black" :class="metric.unitMargin >= 0 ? 'text-emerald-600' : 'text-rose-600'">
              {{ formatMoney(metric.unitMargin) }}
            </p>
          </article>
        </div>

        <div class="mt-3 flex flex-wrap items-center gap-2 text-[11px] font-bold">
          <span class="rounded-full bg-white/90 px-2 py-1 text-slate-600">
            {{ pricingModeLabel(metric.combo.pricingMode) }}
          </span>
          <span class="rounded-full bg-white/90 px-2 py-1 text-slate-600">
            Max {{ formatUnits(metric.maxPossible) }} bolsas
          </span>
          <span class="rounded-full bg-white/90 px-2 py-1 text-slate-600">
            Plan {{ formatUnits(metric.plannedBags) }}
          </span>
        </div>

        <div class="mt-3 rounded-xl border bg-white/70 p-3" :class="[toneClasses(metric.combo.tone).border, toneClasses(metric.combo.tone).soft]">
          <p class="mb-2 text-[11px] font-black uppercase tracking-wide text-slate-500">Checklist de productos</p>
          <ul class="space-y-1">
            <li
              v-for="item in comboChecklist(metric).slice(0, 5)"
              :key="`${metric.combo.id}-${item}`"
              class="flex items-center gap-2 text-xs font-semibold text-slate-700"
            >
              <span
                class="inline-flex h-4 w-4 items-center justify-center rounded border text-[10px]"
                :class="
                  item.startsWith('Pendiente:')
                    ? 'border-amber-300 bg-amber-50 text-amber-700'
                    : 'border-emerald-300 bg-emerald-50 text-emerald-700'
                "
              >
                {{ item.startsWith('Pendiente:') ? "•" : "✓" }}
              </span>
              <span class="truncate" :class="item.startsWith('Pendiente:') ? 'text-amber-700' : ''">
                {{ item }}
              </span>
            </li>
            <li v-if="!comboChecklist(metric).length" class="text-xs font-semibold text-slate-400">Sin productos seleccionados</li>
            <li v-if="comboChecklist(metric).length > 5" class="text-xs font-bold text-slate-500">
              +{{ comboChecklist(metric).length - 5 }} productos más
            </li>
          </ul>
        </div>

        <button
          class="mt-3 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-extrabold text-slate-700 transition hover:border-slate-300 hover:bg-slate-50"
        >
          Gestionar en modal
        </button>
      </article>

      <article
        v-if="!filteredComboMetrics.length"
        class="md:col-span-2 xl:col-span-3 rounded-2xl border-2 border-dashed border-slate-300 bg-white p-8 text-center"
      >
        <p class="text-sm font-bold text-slate-600">No se encontraron combos para "{{ comboSearch }}".</p>
      </article>
    </section>

    <section class="ui-table-wrap">
      <div class="flex items-center justify-between gap-3 border-b border-gray-100 p-6">
        <div>
          <h3 class="text-lg font-bold text-slate-800">Cruce de stock entre combos</h3>
          <p class="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Verifica si un mismo producto quedó sobreasignado.
          </p>
        </div>

        <span
          class="rounded-full px-3 py-1 text-xs font-bold"
          :class="stockConflicts.length ? 'bg-rose-100 text-rose-700' : 'bg-emerald-100 text-emerald-700'"
        >
          {{ stockConflicts.length ? `${stockConflicts.length} conflicto(s)` : "Sin conflictos" }}
        </span>
      </div>

      <table class="ui-table">
        <thead>
          <tr>
            <th>Producto</th>
            <th>Usado en combos</th>
            <th>Stock</th>
            <th>Requerido</th>
            <th>Saldo</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!stockUsageRows.length">
            <td colspan="5" class="text-center text-sm font-semibold text-slate-500">
              Define la cantidad de bolsas para empezar el cruce de stock.
            </td>
          </tr>

          <tr v-for="row in stockUsageRows" :key="row.productId">
            <td>
              <p class="font-bold text-slate-700">{{ row.product.name }}</p>
              <p class="text-xs font-semibold text-slate-400">{{ row.product.brand || "Sin marca" }}</p>
            </td>
            <td>{{ row.comboNames }}</td>
            <td>{{ formatUnits(row.availableUnits) }}</td>
            <td>{{ formatUnits(row.requiredUnits) }}</td>
            <td class="font-bold" :class="row.overflowUnits > 0 ? 'text-rose-600' : 'text-emerald-600'">
              {{ row.overflowUnits > 0 ? `Faltan ${formatUnits(row.overflowUnits)}` : `Sobran ${formatUnits(row.remainingUnits)}` }}
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <div v-if="activeCombo && activeComboMetric" class="fixed inset-0 z-50">
      <button class="absolute inset-0 bg-slate-900/70" aria-label="Cerrar modal" @click="closeComboModal" />

      <section class="absolute inset-x-3 top-3 bottom-3 mx-auto flex max-w-7xl flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl">
        <header class="flex items-center justify-between gap-3 border-b border-gray-100 px-5 py-4">
          <div class="min-w-0">
            <p class="text-xs font-black uppercase tracking-wider text-slate-500">Gestión de combo</p>
            <h2 class="truncate text-xl font-extrabold text-slate-800">{{ activeCombo.name || 'Nuevo combo' }}</h2>
          </div>
          <button class="ui-btn-secondary px-3 py-2" @click="closeComboModal">Cerrar</button>
        </header>

        <div class="flex-1 space-y-5 overflow-y-auto p-5">
          <section class="rounded-xl border border-gray-100 bg-slate-50 p-4">
            <h3 class="text-sm font-black uppercase tracking-wide text-slate-600">Datos del combo</h3>
            <div class="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <label class="ui-label">Nombre</label>
                <input v-model="activeCombo.name" type="text" class="ui-input" @change="sanitizeCombo(activeCombo)" />
              </div>
              <div>
                <label class="ui-label">Color</label>
                <select v-model="activeCombo.tone" class="ui-select" @change="sanitizeCombo(activeCombo)">
                  <option v-for="tone in toneOptions" :key="`modal-${tone.value}`" :value="tone.value">{{ tone.label }}</option>
                </select>
              </div>
              <div class="md:col-span-2">
                <label class="ui-label">Descripción</label>
                <input v-model="activeCombo.note" type="text" class="ui-input" />
              </div>
            </div>
          </section>

          <section class="rounded-xl border border-gray-100 bg-slate-50 p-4">
            <h3 class="text-sm font-black uppercase tracking-wide text-slate-600">Precio del combo</h3>

            <div class="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
              <label
                class="rounded-xl border bg-white p-3 text-sm font-semibold text-slate-700 transition"
                :class="activeCombo.pricingMode === 'base_cost' ? 'border-indigo-400 ring-2 ring-indigo-100' : 'border-gray-200'"
              >
                <span class="flex items-center gap-2">
                  <input v-model="activeCombo.pricingMode" type="radio" value="base_cost" @change="sanitizeCombo(activeCombo)" />
                  1. Base compra
                </span>
                <p class="mt-2 text-xs font-bold text-slate-500">Total: {{ formatMoney(activeComboMetric.baseCostTotal) }}</p>
              </label>

              <label
                class="rounded-xl border bg-white p-3 text-sm font-semibold text-slate-700 transition"
                :class="activeCombo.pricingMode === 'plus10' ? 'border-indigo-400 ring-2 ring-indigo-100' : 'border-gray-200'"
              >
                <span class="flex items-center gap-2">
                  <input v-model="activeCombo.pricingMode" type="radio" value="plus10" @change="sanitizeCombo(activeCombo)" />
                  2. Ganancia 10%
                </span>
                <p class="mt-2 text-xs font-bold text-slate-500">Total: {{ formatMoney(activeComboMetric.baseCostTotal * 1.1) }}</p>
              </label>

              <label
                class="rounded-xl border bg-white p-3 text-sm font-semibold text-slate-700 transition"
                :class="activeCombo.pricingMode === 'absolute' ? 'border-indigo-400 ring-2 ring-indigo-100' : 'border-gray-200'"
              >
                <span class="flex items-center gap-2">
                  <input v-model="activeCombo.pricingMode" type="radio" value="absolute" @change="sanitizeCombo(activeCombo)" />
                  3. Precio absoluto
                </span>
                <input
                  v-model.number="activeCombo.absolutePrice"
                  type="number"
                  min="0"
                  step="0.5"
                  class="ui-input mt-2"
                  :disabled="activeCombo.pricingMode !== 'absolute'"
                  placeholder="Define precio del combo"
                  @change="sanitizeCombo(activeCombo)"
                />
              </label>
            </div>

            <div class="mt-4 grid grid-cols-1 gap-3 md:grid-cols-4">
              <article class="rounded-lg border border-gray-100 bg-white p-3">
                <p class="text-[11px] font-black uppercase tracking-wide text-slate-400">Base compra</p>
                <p class="mt-1 text-sm font-bold text-slate-700">{{ formatMoney(activeComboMetric.baseCostTotal) }}</p>
              </article>

              <article class="rounded-lg border border-gray-100 bg-white p-3">
                <p class="text-[11px] font-black uppercase tracking-wide text-slate-400">Precio combo</p>
                <p class="mt-1 text-sm font-bold text-slate-700">{{ formatMoney(activeComboMetric.comboPrice) }}</p>
              </article>

              <article class="rounded-lg border border-gray-100 bg-white p-3">
                <p class="text-[11px] font-black uppercase tracking-wide text-slate-400">Margen unitario</p>
                <p class="mt-1 text-sm font-bold" :class="activeComboMetric.unitMargin >= 0 ? 'text-emerald-600' : 'text-rose-600'">
                  {{ formatMoney(activeComboMetric.unitMargin) }}
                </p>
              </article>

              <article class="rounded-lg border border-gray-100 bg-white p-3">
                <p class="text-[11px] font-black uppercase tracking-wide text-slate-400">Margen %</p>
                <p class="mt-1 text-sm font-bold" :class="activeComboMetric.marginPct >= 0 ? 'text-emerald-600' : 'text-rose-600'">
                  {{ activeComboMetric.marginPct.toFixed(2) }}%
                </p>
              </article>
            </div>
          </section>

          <section class="rounded-xl border border-gray-100 bg-slate-50 p-4">
            <h3 class="text-sm font-black uppercase tracking-wide text-slate-600">
              Asignación automática por producto (según precio de venta)
            </h3>
            <p class="mt-1 text-xs font-semibold text-slate-500">
              {{
                activeCombo.pricingMode === "absolute"
                  ? "Modo absoluto: el total del combo se reparte por relación de precio de venta y se calcula % de ganancia por producto."
                  : "Modo base/10%: el reparto por producto se hace proporcional al costo de compra."
              }}
            </p>

            <div class="mt-3 overflow-x-auto rounded-xl border border-gray-200 bg-white">
              <table class="min-w-full text-left text-sm">
                <thead class="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-400">
                  <tr>
                    <th class="px-3 py-2">Producto</th>
                    <th class="px-3 py-2">Cant.</th>
                    <th class="px-3 py-2">Costo total</th>
                    <th class="px-3 py-2">Venta ref.</th>
                    <th class="px-3 py-2">Asignado combo</th>
                    <th class="px-3 py-2">Ganancia %</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-if="!activeComboMetric.flatLines.length" class="border-t border-gray-100">
                    <td colspan="6" class="px-3 py-3 text-center text-sm font-semibold text-slate-500">
                      Aún no hay productos seleccionados.
                    </td>
                  </tr>

                  <tr v-for="row in activeComboMetric.flatLines" :key="row.line.id" class="border-t border-gray-100">
                    <td class="px-3 py-3">
                      <p class="font-bold text-slate-700">{{ row.product?.name || 'Sin producto' }}</p>
                      <p class="text-[11px] font-semibold text-slate-400">{{ row.product?.brand || '-' }}</p>
                    </td>
                    <td class="px-3 py-3 font-semibold text-slate-700">{{ formatUnits(row.quantity) }}</td>
                    <td class="px-3 py-3 font-semibold text-slate-700">{{ formatMoney(row.lineCostTotal) }}</td>
                    <td class="px-3 py-3 font-semibold text-slate-700">{{ formatMoney(row.lineSaleTotal) }}</td>
                    <td class="px-3 py-3 font-semibold text-slate-700">{{ formatMoney(row.assignedTotal) }}</td>
                    <td class="px-3 py-3 font-semibold" :class="row.marginPct >= 0 ? 'text-emerald-600' : 'text-rose-600'">
                      {{ row.marginPct.toFixed(2) }}%
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section class="space-y-3 rounded-xl border border-gray-100 bg-slate-50 p-4">
            <div class="flex items-center justify-between gap-2">
              <h3 class="text-sm font-black uppercase tracking-wide text-slate-600">Productos del combo</h3>
              <button class="ui-btn-secondary px-3 py-2" @click="addComponent(activeCombo)">
                + Agregar componente
              </button>
            </div>

            <article
              v-for="(componentRow, componentIndex) in activeComboMetric.components"
              :key="componentRow.component.id"
              class="rounded-xl border border-gray-200 bg-white p-3"
            >
              <div class="mb-3 flex items-center justify-between gap-2">
                <span class="inline-flex items-center rounded-full bg-slate-100 px-2 py-1 text-[11px] font-black text-slate-700">
                  Componente {{ componentIndex + 1 }}
                </span>
                <button
                  class="rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-bold text-rose-700 transition hover:bg-rose-100"
                  @click="removeComponent(activeCombo, componentRow.component.id)"
                >
                  Quitar componente
                </button>
              </div>

              <div class="mb-3">
                <label class="ui-label">Nombre del componente</label>
                <input
                  v-model="componentRow.component.label"
                  type="text"
                  class="ui-input"
                  placeholder="Ej. Cuaderno"
                  @change="sanitizeCombo(activeCombo)"
                />
              </div>

              <div class="space-y-2">
                <div
                  v-for="lineRow in componentRow.lines"
                  :key="lineRow.line.id"
                  class="rounded-lg border border-gray-200 bg-slate-50 p-2"
                >
                  <div class="grid grid-cols-12 gap-2">
                    <div class="col-span-2">
                      <label class="mb-1 block text-[10px] font-bold uppercase tracking-wide text-slate-400">Cant.</label>
                      <input
                        v-model.number="lineRow.line.qtyPerCombo"
                        type="number"
                        min="1"
                        class="w-full rounded-lg border border-gray-200 px-2 py-2 text-sm font-semibold text-slate-700"
                        @change="sanitizeCombo(activeCombo)"
                      />
                    </div>

                    <div class="col-span-8">
                      <label class="mb-1 block text-[10px] font-bold uppercase tracking-wide text-slate-400">Producto</label>
                      <div class="relative">
                        <input
                          v-model="lineRow.line.search"
                          type="text"
                          class="ui-input"
                          placeholder="Selecciona producto"
                          @focus="openLineSearch(lineRow.line.id)"
                          @input="onLineSearchInput(lineRow.line)"
                          @blur="closeLineSearchLater(lineRow.line.id)"
                        />

                        <div
                          v-if="activeSearchLineId === lineRow.line.id"
                          class="absolute left-0 right-0 z-30 mt-1 max-h-56 overflow-y-auto rounded-xl border border-gray-200 bg-white p-1 shadow-xl"
                        >
                          <button
                            v-for="product in getLineSuggestions(componentRow.component, lineRow.line)"
                            :key="`${lineRow.line.id}-${product.id}`"
                            class="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2 text-left text-sm font-medium text-slate-700 transition hover:bg-slate-100"
                            @mousedown.prevent="selectLineProduct(lineRow.line, product)"
                          >
                            <span class="truncate">{{ productLabel(product) }}</span>
                            <span class="shrink-0 text-[11px] font-bold text-slate-500">
                              Stock {{ formatUnits(product.stock_on_hand) }}
                            </span>
                          </button>

                          <p
                            v-if="!getLineSuggestions(componentRow.component, lineRow.line).length"
                            class="px-2 py-2 text-xs font-semibold text-slate-400"
                          >
                            Sin coincidencias.
                          </p>
                        </div>
                      </div>
                    </div>

                    <div class="col-span-2 flex items-end justify-end gap-1">
                      <button
                        class="rounded-lg border border-gray-200 bg-white px-2 py-2 text-[11px] font-bold text-slate-500 transition hover:bg-slate-100"
                        @click="clearLineProduct(lineRow.line)"
                      >
                        Limpiar
                      </button>
                      <button
                        class="rounded-lg border border-rose-200 bg-rose-50 px-2 py-2 text-[11px] font-bold text-rose-700 transition hover:bg-rose-100"
                        @click="removeLine(componentRow.component, lineRow.line.id)"
                      >
                        Quitar
                      </button>
                    </div>
                  </div>

                  <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-semibold text-slate-500">
                    <span>Stock: {{ lineRow.product ? formatUnits(lineRow.availableUnits) : "-" }}</span>
                    <span>Costo: {{ lineRow.product ? formatMoney(lineRow.lineCostTotal) : "-" }}</span>
                    <span>Venta ref: {{ lineRow.product ? formatMoney(lineRow.lineSaleTotal) : "-" }}</span>
                  </div>
                </div>
              </div>

              <div class="mt-3 flex flex-wrap items-center gap-3">
                <button class="ui-btn-secondary px-3 py-2" @click="addLine(componentRow.component)">
                  + Agregar producto
                </button>

                <span class="text-xs font-semibold text-slate-500">
                  Total piezas: {{ formatUnits(componentRow.requiredUnits) }}
                </span>

                <span class="text-xs font-semibold" :class="componentRow.ready ? 'text-slate-500' : 'text-rose-600'">
                  {{ componentRow.ready ? `Max por stock: ${formatUnits(componentRow.maxByStock)} bolsas` : "Selecciona al menos un producto" }}
                </span>
              </div>
            </article>
          </section>
        </div>
      </section>
    </div>
  </div>
</template>
