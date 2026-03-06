<script setup lang="ts">
// ─── Types ──────────────────────────────────────────────────────────────────
type ExtractedItem = {
  qty: number;
  item: string;
  raw: string;
  marcado?: string;
};

type ProductOption = {
  product_id: string;
  sku: string;
  name: string;
  unit: string;
  sale_price: number;
  stock_on_hand: number;
  score: number;
};

type MatchedItem = {
  requested_item: string;
  requested_qty: number;
  raw: string;
  marcado?: string;
  best_match: ProductOption | null;
  alternatives: ProductOption[];
  stock_status: "ok" | "low" | "no_match";
};

type OrderLine = {
  matched: MatchedItem;
  qty: number;
  selected: ProductOption | null;
};

type Step = 0 | 1 | 2 | 3 | 4;

// ─── State ───────────────────────────────────────────────────────────────────
const step = ref<Step>(0);
const loading = ref(false);
const error = ref("");

// Step 1
const imageFile = ref<File | null>(null);
const imagePreviewUrl = ref("");
const imageInputRef = ref<HTMLInputElement | null>(null);
const manualText = ref("");
const inputMode = ref<"image" | "text">("image");

const pendingExtraction = ref<ExtractedItem[]>([]);
const showMarkedModal = ref(false);

// Step 2 — matched items
const orderLines = ref<OrderLine[]>([]);

// Step 3 — customization
const coverColor = ref("");
const boxType = ref<"bolsa" | "caja" | "sin_empaque">("bolsa");
const boxColor = ref("azul");
const studentName = ref("");
const addStudentName = ref(false);

// Step 4
const orderSent = ref(false);

// ─── Dashboard State ─────────────────────────────────────────────────────────
const activeDashboardTab = ref<"global" | "detail">("global");
const selectedVariant = ref<"default" | "economic" | "premium">("default");
const allListsStock = ref<any[]>([]);
const selectedListAnalysis = ref<any>(null);
const dashLoading = ref(false);

const loadDashboard = async () => {
  dashLoading.value = true;
  try {
    allListsStock.value = await $fetch<any[]>("/api/school/all-lists-stock");
  } catch (err: any) {
    error.value = "Error cargando dashboard: " + err.message;
  } finally {
    dashLoading.value = false;
  }
};

const viewListDetail = async (listId: string) => {
  dashLoading.value = true;
  error.value = "";
  try {
    selectedListAnalysis.value = await $fetch<any>(
      `/api/school/stock-analysis?list_id=${listId}`,
    );
    activeDashboardTab.value = "detail";
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (err: any) {
    error.value = "Error cargando detalle: " + err.message;
  } finally {
    dashLoading.value = false;
  }
};

const peditListDirectly = () => {
  if (!selectedListAnalysis.value) return;
  const variantStr = selectedVariant.value as
    | "default"
    | "economic"
    | "premium";
  orderLines.value = selectedListAnalysis.value.items.map((item: any) => {
    // Safely check if the variant properties exist
    const variantData = item.variants?.[variantStr] ||
      item.variants?.default || {
        match_status: "no_match",
        linked_product: null,
      };

    return {
      matched: {
        requested_item: item.description,
        requested_qty: item.qty,
        raw: item.description,
        best_match: variantData.linked_product,
        alternatives: variantData.linked_product
          ? [variantData.linked_product]
          : [],
        stock_status: variantData.match_status,
      },
      qty: item.qty,
      selected: variantData.linked_product,
    };
  });
  step.value = 2;
};

onMounted(() => {
  loadDashboard();
});

// ─── Constants ───────────────────────────────────────────────────────────────
const coverColors = [
  { id: "", label: "Sin forro", hex: "#E2E8F0" },
  { id: "celeste", label: "Celeste", hex: "#7DD3FC" },
  { id: "azul", label: "Azul", hex: "#3B82F6" },
  { id: "rojo", label: "Rojo", hex: "#EF4444" },
  { id: "verde", label: "Verde", hex: "#22C55E" },
  { id: "amarillo", label: "Amarillo", hex: "#EAB308" },
  { id: "naranja", label: "Naranja", hex: "#F97316" },
  { id: "rosado", label: "Rosado", hex: "#EC4899" },
  { id: "morado", label: "Morado", hex: "#8B5CF6" },
  { id: "blanco", label: "Blanco", hex: "#F8FAFC" },
  { id: "negro", label: "Negro", hex: "#1E293B" },
];

const boxColors = [
  { id: "azul", label: "Azul", hex: "#3B82F6" },
  { id: "celeste", label: "Celeste", hex: "#7DD3FC" },
  { id: "rojo", label: "Rojo", hex: "#EF4444" },
  { id: "verde", label: "Verde", hex: "#22C55E" },
  { id: "amarillo", label: "Amarillo", hex: "#EAB308" },
  { id: "naranja", label: "Naranja", hex: "#F97316" },
  { id: "rosado", label: "Rosado", hex: "#EC4899" },
  { id: "morado", label: "Morado", hex: "#8B5CF6" },
  { id: "blanco", label: "Blanco", hex: "#F8FAFC" },
  { id: "negro", label: "Negro", hex: "#1E293B" },
];

// ─── Computed ─────────────────────────────────────────────────────────────────
const orderTotal = computed(() =>
  orderLines.value.reduce((sum: number, line: any) => {
    const price = line.selected?.sale_price ?? 0;
    return sum + price * line.qty;
  }, 0),
);

const validLines = computed(() =>
  orderLines.value.filter((l: any) => l.selected),
);

const boxColorHex = computed(
  () => boxColors.find((c) => c.id === boxColor.value)?.hex ?? "#3B82F6",
);
const coverColorHex = computed(
  () => coverColors.find((c) => c.id === coverColor.value)?.hex ?? "#E2E8F0",
);

const boxTypeLabel = computed(() => {
  if (boxType.value === "bolsa") return "Bolsa";
  if (boxType.value === "caja") return "Caja";
  return "Sin empaque";
});

// ─── Helpers ─────────────────────────────────────────────────────────────────
const formatMoney = (v: number) => `S/ ${Number(v).toFixed(2)}`;

const stockBadge = (line: OrderLine) => {
  if (!line.selected)
    return { label: "Sin match", cls: "bg-rose-100 text-rose-700" };
  const avail = line.selected.stock_on_hand;
  if (avail <= 0)
    return { label: "Sin stock", cls: "bg-rose-100 text-rose-700" };
  if (avail < line.qty)
    return {
      label: `Stock bajo (${avail})`,
      cls: "bg-amber-100 text-amber-700",
    };
  return { label: `✓ Disponible`, cls: "bg-emerald-100 text-emerald-700" };
};

const selectProduct = (lineIdx: number, product: ProductOption) => {
  orderLines.value[lineIdx].selected = product;
};

const setInputMode = (id: string) => {
  inputMode.value = id as "image" | "text";
};

const setBoxType = (id: string) => {
  boxType.value = id as "bolsa" | "caja" | "sin_empaque";
};

// ─── Image compression helper (Canvas API) ───────────────────────────────────
const compressImage = (
  file: File,
  maxPx = 1200,
  quality = 0.82,
): Promise<File> => {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const ratio = Math.min(maxPx / img.width, maxPx / img.height, 1);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * ratio);
      canvas.height = Math.round(img.height * ratio);
      canvas
        .getContext("2d")!
        .drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        (blob) =>
          resolve(
            blob ? new File([blob], file.name, { type: "image/jpeg" }) : file,
          ),
        "image/jpeg",
        quality,
      );
    };
    img.onerror = () => resolve(file);
    img.src = url;
  });
};

// ─── Step 1: analyze image ────────────────────────────────────────────────────
const ALLOWED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
];

const onFileChange = (e: Event) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    error.value = "Solo se permiten imágenes (JPG, PNG, WEBP, GIF).";
    return;
  }
  imageFile.value = file;
  imagePreviewUrl.value = URL.createObjectURL(file);
  error.value = "";
};

const onDrop = (e: DragEvent) => {
  const file = e.dataTransfer?.files?.[0];
  if (!file || !file.type.startsWith("image/")) return;
  imageFile.value = file;
  imagePreviewUrl.value = URL.createObjectURL(file);
  error.value = "";
};

const analyzeImage = async () => {
  error.value = "";
  loading.value = true;
  let extracted: ExtractedItem[] = [];

  try {
    if (inputMode.value === "image") {
      if (!imageFile.value) {
        error.value = "Selecciona una imagen primero.";
        return;
      }
      // Compress before upload: resize to max 1200px, JPEG 0.82 quality
      // Typical phone photo: 4MB → ~150KB after compression
      const compressed = await compressImage(imageFile.value);
      const form = new FormData();
      form.append("image", compressed);
      const res = await $fetch<{ items: ExtractedItem[] }>(
        "/api/utiles/analyze-image",
        {
          method: "POST",
          body: form,
        },
      );
      extracted = res.items || [];
    } else {
      // Parse manual text: each line is an item
      const lines = manualText.value
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      extracted = lines.map((line) => {
        const m = line.match(/^(\d+)\s+(.+)$/);
        if (m) return { qty: parseInt(m[1]), item: m[2], raw: line };
        return { qty: 1, item: line, raw: line };
      });
    }

    if (!extracted.length) {
      error.value =
        "No se encontraron ítems en la lista. Intenta con otra imagen o escribe la lista manualmente.";
      loading.value = false;
      return;
    }

    // Check for marked items (checks, ticks, "falta")
    const markedCount = extracted.filter((item) => !!item.marcado).length;
    if (markedCount > 0 && markedCount < extracted.length) {
      // Pause process and ask the user
      pendingExtraction.value = extracted;
      showMarkedModal.value = true;
      loading.value = false;
    } else {
      // Process normally
      await processMatch(extracted);
    }
  } catch (err: any) {
    error.value =
      err?.data?.statusMessage || err?.message || "Error al analizar la lista.";
    loading.value = false;
  }
};

const proceedWithMatch = async (filterMarked: boolean) => {
  showMarkedModal.value = false;
  const itemsToProcess = filterMarked
    ? pendingExtraction.value.filter((item) => !!item.marcado)
    : pendingExtraction.value;
  await processMatch(itemsToProcess);
};

const processMatch = async (items: ExtractedItem[]) => {
  error.value = "";
  loading.value = true;
  try {
    const res2 = await $fetch<{ matched: MatchedItem[] }>("/api/utiles/match", {
      method: "POST",
      body: { items },
    });

    orderLines.value = (res2.matched || []).map((m) => ({
      matched: m,
      qty: m.requested_qty,
      selected: m.best_match,
    }));
    step.value = 2;
  } catch (err: any) {
    error.value =
      err?.data?.statusMessage ||
      err?.message ||
      "Error al buscar los ítems en el stock.";
  } finally {
    loading.value = false;
  }
};

// ─── Step navigation ──────────────────────────────────────────────────────────
const goToStep3 = () => {
  step.value = 3;
};
const goToStep4 = () => {
  step.value = 4;
};
const goBack = () => {
  if (step.value === 2) step.value = 1;
  else if (step.value === 3) step.value = 2;
  else if (step.value === 4) step.value = 3;
};

const resetAll = () => {
  step.value = 0;
  imageFile.value = null;
  imagePreviewUrl.value = "";
  manualText.value = "";
  orderLines.value = [];
  coverColor.value = "";
  boxType.value = "bolsa";
  boxColor.value = "azul";
  studentName.value = "";
  addStudentName.value = false;
  orderSent.value = false;
  error.value = "";
  pendingExtraction.value = [];
  showMarkedModal.value = false;
};

const sendToCart = async () => {
  // Build items for the sales cart via query params / localStorage bridge
  const items = validLines.value.map((line) => ({
    product_id: line.selected!.product_id,
    name: line.selected!.name,
    sku: line.selected!.sku,
    unit_name: line.selected!.unit,
    factor_to_base: 1,
    qty: line.qty,
    auto_price_unit: line.selected!.sale_price,
    price_unit: line.selected!.sale_price,
    pricing_source: "utiles",
    pricing_detail: {},
    manual_discount_pct: 0,
    manual_discount_amount: 0,
    manual_discount_reason: "",
    manual_price_override: null,
  }));

  if (import.meta.client) {
    localStorage.setItem(
      "papeleria_pos_draft_v1",
      JSON.stringify({
        customer_id: null,
        payment_method: "efectivo",
        items,
      }),
    );
  }

  orderSent.value = true;
  await navigateTo({ path: "/sales", query: { view: "pos" } });
};
</script>

<template>
  <div class="space-y-6 pb-16">
    <!-- Header + Stepper -->
    <div class="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div
        class="flex flex-wrap items-center gap-4 border-b border-slate-100 px-6 py-5"
      >
        <div
          class="flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-600 shadow-lg shadow-indigo-900/20"
        >
          <!-- backpack icon -->
          <svg
            class="h-6 w-6 text-white"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9zM9 9h6"
            />
          </svg>
        </div>
        <div>
          <h2 class="text-lg font-extrabold text-slate-800">
            Módulo de Útiles Escolares
          </h2>
          <p class="text-sm text-slate-500">
            Arma pedidos escolares inteligentes con stock en tiempo real
          </p>
        </div>
      </div>

      <!-- Stepper -->
      <div
        v-if="step > 0"
        class="flex items-center gap-0 overflow-x-auto px-6 py-4"
      >
        <template
          v-for="(label, idx) in [
            'Ingresar lista',
            'Revisar pedido',
            'Personalizar',
            'Vista previa',
          ]"
          :key="label"
        >
          <div class="flex min-w-0 items-center gap-2">
            <div
              class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold transition-all"
              :class="
                step > idx + 1
                  ? 'bg-indigo-600 text-white'
                  : step === idx + 1
                    ? 'bg-indigo-600 text-white ring-4 ring-indigo-100'
                    : 'bg-slate-100 text-slate-400'
              "
            >
              <svg
                v-if="step > idx + 1"
                class="h-4 w-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2.5"
                  d="M5 13l4 4L19 7"
                />
              </svg>
              <span v-else>{{ idx + 1 }}</span>
            </div>
            <span
              class="hidden text-xs font-semibold sm:block"
              :class="
                step === idx + 1
                  ? 'text-indigo-700'
                  : step > idx + 1
                    ? 'text-indigo-400'
                    : 'text-slate-400'
              "
              >{{ label }}</span
            >
          </div>
          <div
            v-if="idx < 3"
            :key="'sep-' + label"
            class="mx-2 h-px flex-1 bg-slate-200"
          />
        </template>
      </div>
    </div>

    <!-- ───────────── STEP 0: Dashboard Analizador ───────────── -->
    <div v-if="step === 0" class="space-y-6">
      <!-- Dashboard Tabs -->
      <div
        class="flex gap-2 rounded-xl border border-slate-200 bg-white p-1 shadow-sm w-fit"
      >
        <button
          class="rounded-lg px-4 py-2 text-sm font-semibold transition-all"
          :class="
            activeDashboardTab === 'global'
              ? 'bg-indigo-600 text-white shadow'
              : 'text-slate-500 hover:text-slate-800'
          "
          @click="activeDashboardTab = 'global'"
        >
          🌐 Todas las listas activas
        </button>
        <button
          class="rounded-lg px-4 py-2 text-sm font-semibold transition-all"
          :class="
            activeDashboardTab === 'detail'
              ? 'bg-indigo-600 text-white shadow'
              : 'text-slate-500 hover:text-slate-800'
          "
          @click="selectedListAnalysis ? (activeDashboardTab = 'detail') : null"
          :disabled="!selectedListAnalysis"
        >
          📋 Detalle de lista seleccionada
        </button>
      </div>

      <!-- Error Global -->
      <div
        v-if="error"
        class="rounded-xl bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700 border border-rose-200"
      >
        {{ error }}
      </div>
      <div v-if="dashLoading" class="flex items-center justify-center p-12">
        <svg
          class="h-8 w-8 animate-spin text-indigo-500"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle
            class="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            stroke-width="4"
          ></circle>
          <path
            class="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
          ></path>
        </svg>
      </div>

      <!-- Global View -->
      <div
        v-if="activeDashboardTab === 'global' && !dashLoading"
        class="space-y-4"
      >
        <div class="flex items-center justify-between">
          <h3 class="text-lg font-bold text-slate-800">
            Listas Disponibles (Stock Activo)
          </h3>
          <button class="ui-btn-secondary" @click="step = 1">
            Crear pedido con IA/Texto
          </button>
        </div>

        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div
            v-for="list in allListsStock"
            :key="list.id"
            class="group rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-indigo-300 hover:shadow-md cursor-pointer relative"
            @click="viewListDetail(list.id)"
          >
            <!-- Badge -->
            <div
              v-if="list.badge"
              class="absolute -top-3 left-4 rounded-full px-3 py-1 text-xs font-black uppercase tracking-wider shadow-sm"
              :class="{
                'bg-emerald-100 text-emerald-700':
                  list.badge.includes('retorno'),
                'bg-amber-100 text-amber-700': list.badge.includes('restock'),
                'bg-rose-100 text-rose-700': list.badge.includes('Alta'),
                'bg-indigo-100 text-indigo-700':
                  !list.badge.includes('retorno') &&
                  !list.badge.includes('restock') &&
                  !list.badge.includes('Alta'),
              }"
            >
              {{ list.badge }}
            </div>

            <div class="mt-2 space-y-1">
              <p class="text-xs font-bold text-indigo-600 uppercase">
                {{ list.institution_name }}
              </p>
              <h4 class="text-base font-extrabold text-slate-800">
                {{ list.grade_name }} - {{ list.section_name }} ({{
                  list.year
                }})
              </h4>
            </div>

            <div
              class="mt-5 grid grid-cols-2 gap-3 rounded-xl bg-slate-50 p-3 text-sm"
            >
              <div class="col-span-2">
                <p class="text-xs text-slate-500 font-medium h-4">
                  Rango de Precios
                </p>
                <div class="flex items-center gap-1.5 mt-1">
                  <span class="font-bold text-slate-800 text-base"
                    >S/ {{ list.price_min.toFixed(2) }}</span
                  >
                  <span class="text-slate-400 text-xs">a</span>
                  <span class="font-bold text-slate-800 text-base"
                    >S/ {{ list.price_max.toFixed(2) }}</span
                  >
                </div>
              </div>
              <div class="col-span-2 border-t border-slate-200/60 mt-1"></div>
              <div>
                <p class="text-xs text-slate-500 font-medium">
                  Cobertura stock
                </p>
                <p class="font-bold text-slate-800">
                  {{ list.coverage_pct.toFixed(0) }}% ítems listos
                </p>
              </div>
              <div>
                <p class="text-xs text-slate-500 font-medium">
                  Puedes vender
                </p>
                <p class="font-bold text-slate-800">
                  {{ list.completable_sets }} listas completas x S/
                  {{ list.total_price.toFixed(2) }}
                </p>
                <p class="text-[11px] text-slate-400">
                  (considera hasta 20% de faltantes)
                </p>
              </div>
              <div class="col-span-2 border-t border-slate-200/60 pt-2">
                <p class="text-xs text-slate-500 font-medium">
                  Valor realizable estimado
                </p>
                <p class="text-lg font-black text-emerald-600">
                  S/ {{ list.realizable_value.toFixed(2) }}
                </p>
              </div>
            </div>
            <button
              class="mt-4 w-full rounded-lg bg-indigo-50 py-2.5 text-sm font-semibold text-indigo-700 transition group-hover:bg-indigo-600 group-hover:text-white"
            >
              Ver Detalle y Pedir →
            </button>
          </div>
        </div>
        <p v-if="!allListsStock.length" class="ui-empty-state">
          No hay listas activas con productos vinculados.
        </p>
      </div>

      <!-- Detail View -->
      <div
        v-else-if="
          activeDashboardTab === 'detail' &&
          selectedListAnalysis &&
          !dashLoading
        "
        class="space-y-6"
      >
        <!-- Header -->
        <div
          class="flex flex-wrap gap-4 items-center justify-between rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
        >
          <div>
            <p class="text-sm font-bold text-indigo-600 uppercase">
              {{ selectedListAnalysis.list.institution_name }}
            </p>
            <h3 class="text-xl font-black text-slate-800">
              {{ selectedListAnalysis.list.grade_name }} -
              {{ selectedListAnalysis.list.section_name }} ({{
                selectedListAnalysis.list.year
              }})
            </h3>
            <p
              v-if="selectedListAnalysis.list.notes"
              class="mt-1 text-sm text-slate-500"
            >
              {{ selectedListAnalysis.list.notes }}
            </p>
          </div>
          <div class="flex gap-3">
            <button class="ui-btn-secondary" @click="step = 1">
              Crear manual con IA/Texto
            </button>
            <button
              class="ui-btn shadow-md"
              @click="peditListDirectly"
              :disabled="selectedListAnalysis.metrics.coverage_pct === 0"
            >
              ⚡ Pedir esta lista ahora
            </button>
          </div>
        </div>

        <!-- Variant Tabs -->
        <div class="flex justify-center -mb-2">
          <div class="flex bg-slate-100 p-1 rounded-xl w-full max-w-md">
            <button
              class="flex-1 rounded-lg py-2.5 text-sm font-semibold transition-all relative overflow-hidden"
              :class="
                selectedVariant === 'economic'
                  ? 'bg-white text-indigo-700 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              "
              @click="selectedVariant = 'economic'"
            >
              <span class="relative z-10 flex flex-col items-center">
                <span
                  class="text-xs font-bold uppercase tracking-wider opacity-70 mb-0.5"
                  >Económico</span
                >
                <span class="font-black"
                  >S/
                  {{
                    selectedListAnalysis.metrics.economic.total_price.toFixed(2)
                  }}</span
                >
              </span>
              <div
                v-if="selectedVariant === 'economic'"
                class="absolute inset-0 bg-indigo-50/50"
              ></div>
            </button>
            <button
              class="flex-1 rounded-lg py-2.5 text-sm font-semibold transition-all relative overflow-hidden"
              :class="
                selectedVariant === 'default'
                  ? 'bg-indigo-600 text-white shadow-md'
                  : 'text-slate-500 hover:text-slate-700'
              "
              @click="selectedVariant = 'default'"
            >
              <span class="relative z-10 flex flex-col items-center">
                <span
                  class="text-xs font-bold uppercase tracking-wider opacity-90 mb-0.5"
                  :class="
                    selectedVariant === 'default' ? 'text-indigo-100' : ''
                  "
                  >Recomendado</span
                >
                <span class="font-black"
                  >S/
                  {{
                    selectedListAnalysis.metrics.default.total_price.toFixed(2)
                  }}</span
                >
              </span>
            </button>
            <button
              class="flex-1 rounded-lg py-2.5 text-sm font-semibold transition-all relative overflow-hidden"
              :class="
                selectedVariant === 'premium'
                  ? 'bg-white text-indigo-700 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              "
              @click="selectedVariant = 'premium'"
            >
              <span class="relative z-10 flex flex-col items-center">
                <span
                  class="text-xs font-bold uppercase tracking-wider opacity-70 mb-0.5"
                  >Premium</span
                >
                <span class="font-black"
                  >S/
                  {{
                    selectedListAnalysis.metrics.premium.total_price.toFixed(2)
                  }}</span
                >
              </span>
              <div
                v-if="selectedVariant === 'premium'"
                class="absolute inset-0 bg-amber-50/50"
              ></div>
            </button>
          </div>
        </div>

        <!-- KPIs for Selected Variant -->
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div
            class="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm relative overflow-hidden"
          >
            <div
              class="absolute -right-6 -bottom-6 opacity-[0.03] text-indigo-900"
            >
              <svg class="h-24 w-24" fill="currentColor" viewBox="0 0 24 24">
                <path
                  d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"
                />
              </svg>
            </div>
            <p
              class="text-xs font-semibold uppercase tracking-wider text-slate-500"
            >
              Valor de 1 lista
            </p>
            <p class="mt-1 text-2xl font-black text-slate-800">
              S/
              {{
                selectedListAnalysis.metrics[
                  selectedVariant
                ].total_price.toFixed(2)
              }}
            </p>
          </div>
          <div
            class="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
          >
            <p
              class="text-xs font-semibold uppercase tracking-wider text-slate-500"
            >
              Cuántas Listas Puedes Vender
            </p>
            <p class="mt-1 text-2xl font-black text-indigo-600">
              {{
                selectedListAnalysis.metrics[selectedVariant].completable_sets
              }}
              <span class="text-lg font-bold text-slate-400">listas</span>
            </p>
            <p class="text-xs text-slate-400">
              Con tolerancia de 20% de faltantes
            </p>
          </div>
          <div
            class="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
          >
            <p
              class="text-xs font-semibold uppercase tracking-wider text-slate-500"
            >
              Cobertura de Stock
            </p>
            <p
              class="mt-1 text-2xl font-black"
              :class="
                selectedListAnalysis.metrics[selectedVariant].coverage_pct > 80
                  ? 'text-emerald-600'
                  : 'text-amber-500'
              "
            >
              {{
                selectedListAnalysis.metrics[
                  selectedVariant
                ].coverage_pct.toFixed(0)
              }}%
              <span class="text-sm font-bold text-slate-400">ok</span>
            </p>
          </div>
          <div
            class="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 shadow-sm"
          >
            <p
              class="text-xs font-semibold uppercase tracking-wider text-emerald-600"
            >
              Valor Realizable
            </p>
            <p class="mt-1 text-2xl font-black text-emerald-700">
              S/
              {{
                selectedListAnalysis.metrics[
                  selectedVariant
                ].realizable_value.toFixed(2)
              }}
            </p>
            <p class="text-xs font-medium text-emerald-600/80">
              Si vendes el stock actual
            </p>
          </div>
        </div>

        <!-- Items Table -->
        <div
          class="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden"
        >
          <div
            class="px-6 py-4 border-b border-slate-100 bg-slate-50 flex justify-between items-center"
          >
            <h4 class="font-bold text-slate-800">
              {{ selectedListAnalysis.metrics.total_items }} Útiles Requeridos
            </h4>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full text-left text-sm">
              <thead
                class="bg-white border-b border-slate-200 text-xs uppercase text-slate-500 font-bold"
              >
                <tr>
                  <th class="px-6 py-3">Útil Requerido</th>
                  <th class="px-6 py-3">Cant</th>
                  <th class="px-6 py-3">Producto Vinculado</th>
                  <th class="px-6 py-3">Estado Stock</th>
                  <th class="px-6 py-3 text-right">Precio Unit.</th>
                  <th class="px-6 py-3 text-right">Subtotal</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-100">
                <tr
                  v-for="item in selectedListAnalysis.items"
                  :key="item.id"
                  class="hover:bg-slate-50"
                >
                  <td class="px-6 py-4">
                    <p
                      class="font-semibold text-slate-800 max-w-xs truncate"
                      :title="item.description"
                    >
                      {{ item.description }}
                    </p>
                    <p v-if="item.notes" class="text-xs text-slate-400 mt-0.5">
                      {{ item.notes }}
                    </p>
                  </td>
                  <td class="px-6 py-4 font-bold text-slate-800">
                    {{ item.qty }}
                  </td>
                  <td class="px-6 py-4">
                    <div
                      v-if="
                        item.variants[selectedVariant] &&
                        item.variants[selectedVariant].linked_product
                      "
                    >
                      <p
                        class="font-semibold text-indigo-600 truncate max-w-[200px]"
                        :title="
                          item.variants[selectedVariant].linked_product.name
                        "
                      >
                        {{ item.variants[selectedVariant].linked_product.name }}
                      </p>
                      <p class="text-xs text-slate-500">
                        {{
                          item.variants[selectedVariant].linked_product.brand ||
                          "Genérico"
                        }}
                      </p>
                    </div>
                    <span v-else class="text-xs text-amber-500 font-bold"
                      >⚠️ No vinculado</span
                    >
                  </td>
                  <td class="px-6 py-4">
                    <span
                      v-if="
                        !item.variants[selectedVariant] ||
                        !item.variants[selectedVariant].linked_product
                      "
                      class="inline-flex rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-bold text-slate-500"
                      >Pendiente</span
                    >
                    <span
                      v-else-if="
                        item.variants[selectedVariant].match_status === 'ok'
                      "
                      class="inline-flex rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-bold text-emerald-700"
                      >✓
                      {{
                        item.variants[selectedVariant].linked_product
                          .stock_on_hand
                      }}
                      en stock</span
                    >
                    <span
                      v-else-if="
                        item.variants[selectedVariant].match_status === 'low'
                      "
                      class="inline-flex rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-bold text-amber-700"
                      >Stock bajo ({{
                        item.variants[selectedVariant].linked_product
                          .stock_on_hand
                      }})</span
                    >
                    <span
                      v-else
                      class="inline-flex rounded-full bg-rose-100 px-2.5 py-0.5 text-xs font-bold text-rose-700"
                      >Sin stock (0)</span
                    >
                  </td>
                  <td class="px-6 py-4 text-right font-medium text-slate-600">
                    {{
                      item.variants[selectedVariant] &&
                      item.variants[selectedVariant].linked_product
                        ? "S/ " +
                          item.variants[
                            selectedVariant
                          ].linked_product.sale_price.toFixed(2)
                        : "-"
                    }}
                  </td>
                  <td class="px-6 py-4 text-right font-bold text-slate-800">
                    {{
                      item.variants[selectedVariant] &&
                      item.variants[selectedVariant].linked_product
                        ? "S/ " +
                          item.variants[selectedVariant].subtotal.toFixed(2)
                        : "-"
                    }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>

    <!-- ───────────── STEP 1: Input ───────────── -->
    <div v-if="step === 1" class="space-y-4">
      <!-- Mode toggle -->
      <div
        class="flex gap-2 rounded-xl border border-slate-200 bg-white p-1 shadow-sm w-fit"
      >
        <button
          v-for="mode in [
            { id: 'image', label: '📷 Subir imagen' },
            { id: 'text', label: '✏️ Escribir lista' },
          ]"
          :key="mode.id"
          class="rounded-lg px-4 py-2 text-sm font-semibold transition-all"
          :class="
            inputMode === mode.id
              ? 'bg-indigo-600 text-white shadow'
              : 'text-slate-500 hover:text-slate-800'
          "
          @click="setInputMode(mode.id)"
        >
          {{ mode.label }}
        </button>
      </div>

      <!-- IMAGE MODE -->
      <div
        v-if="inputMode === 'image'"
        class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <div
          class="relative flex min-h-72 cursor-pointer flex-col items-center justify-center gap-4 rounded-xl border-2 border-dashed transition-all"
          :class="
            imageFile
              ? 'border-indigo-300 bg-indigo-50/30'
              : 'border-slate-300 bg-slate-50 hover:border-indigo-300 hover:bg-indigo-50/30'
          "
          @click="imageInputRef?.click()"
          @dragover.prevent
          @drop.prevent="onDrop"
        >
          <input
            ref="imageInputRef"
            type="file"
            accept="image/*"
            class="hidden"
            @change="onFileChange"
          />

          <template v-if="!imageFile">
            <div
              class="flex h-16 w-16 items-center justify-center rounded-2xl bg-indigo-100"
            >
              <svg
                class="h-8 w-8 text-indigo-500"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="1.5"
                  d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                />
              </svg>
            </div>
            <div class="text-center">
              <p class="text-base font-bold text-slate-700">
                Sube la lista de útiles
              </p>
              <p class="mt-1 text-sm text-slate-500">
                Foto de la hoja, impresa o escrita a mano
              </p>
              <p class="mt-0.5 text-xs text-slate-400">
                PNG, JPG, WEBP · Arrastra o haz clic
              </p>
            </div>
            <button
              class="ui-btn !py-2 !px-6"
              @click.stop="imageInputRef?.click()"
            >
              Seleccionar imagen
            </button>
          </template>

          <template v-else>
            <img
              :src="imagePreviewUrl"
              class="max-h-64 rounded-xl object-contain shadow-md"
              alt="Preview"
            />
            <button
              class="absolute right-3 top-3 flex items-center gap-1 rounded-lg bg-white px-2 py-1 text-xs font-semibold text-slate-600 shadow hover:text-rose-600"
              @click.stop="
                imageFile = null;
                imagePreviewUrl = '';
              "
            >
              <svg
                class="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
              Cambiar
            </button>
          </template>
        </div>

        <p class="mt-3 flex items-center gap-2 text-xs text-slate-400">
          <svg
            class="h-4 w-4 text-indigo-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          GPT-4o Vision analiza la imagen y extrae automáticamente los útiles
          con cantidades
        </p>
      </div>

      <!-- TEXT MODE -->
      <div
        v-else
        class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <label class="mb-2 block text-sm font-bold text-slate-700">
          Escribe o pega la lista de útiles
        </label>
        <textarea
          v-model="manualText"
          class="ui-input h-56 w-full resize-none font-mono text-sm"
          placeholder="Ejemplo:&#10;3 cuadernos rayados A4&#10;2 lapiceros azul&#10;1 regla 30cm&#10;1 borrador&#10;1 tajador con depósito"
        />
        <p class="mt-2 text-xs text-slate-400">
          Un ítem por línea. Puedes incluir la cantidad al inicio.
        </p>
      </div>

      <!-- Error -->
      <div
        v-if="error"
        class="rounded-xl bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700 border border-rose-200"
      >
        {{ error }}
      </div>

      <!-- CTA -->
      <div class="flex justify-end">
        <button
          class="ui-btn !h-12 !px-8 !text-base"
          :disabled="
            loading || (inputMode === 'image' ? !imageFile : !manualText.trim())
          "
          @click="analyzeImage"
        >
          <svg
            v-if="loading"
            class="mr-2 h-5 w-5 animate-spin"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              class="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              stroke-width="4"
            />
            <path
              class="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
          <span>{{ loading ? "Analizando…" : "🔍 Analizar lista" }}</span>
        </button>
      </div>
    </div>

    <!-- Marked Items Modal Overlay -->
    <div
      v-if="showMarkedModal"
      class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm"
    >
      <div
        class="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl border border-slate-100"
      >
        <div class="flex items-center gap-3">
          <div
            class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-600"
          >
            <svg
              class="h-6 w-6"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
              />
            </svg>
          </div>
          <h3 class="text-lg font-bold text-slate-800">
            Lista con marcas a mano
          </h3>
        </div>

        <p class="mt-4 text-sm text-slate-600">
          Hemos detectado
          <strong
            >{{
              pendingExtraction.filter((i) => !!i.marcado).length
            }}
            ítems</strong
          >
          marcados en la imagen (ej: "Falta", checks, subrayados).
        </p>
        <p class="mt-2 text-sm text-slate-600 font-medium">
          ¿Qué deseas cotizar para este cliente?
        </p>

        <div class="mt-6 flex flex-col gap-3">
          <button
            class="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 hover:border-slate-300"
            @click="proceedWithMatch(false)"
          >
            <span>Cotizar lista completa</span>
            <span
              class="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-500 font-bold border border-slate-200"
            >
              {{ pendingExtraction.length }} ítems
            </span>
          </button>

          <button
            class="flex items-center justify-between rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white shadow-md transition hover:bg-indigo-700 hover:shadow-lg"
            @click="proceedWithMatch(true)"
          >
            <span>Cotizar SOLO lo marcado</span>
            <span
              class="rounded bg-indigo-500/80 px-2 py-0.5 text-xs text-white font-bold backdrop-blur-sm"
            >
              {{ pendingExtraction.filter((i) => !!i.marcado).length }} ítems
            </span>
          </button>
        </div>

        <button
          class="mt-4 w-full text-center text-xs font-medium text-slate-400 hover:text-slate-600"
          @click="
            showMarkedModal = false;
            loading = false;
          "
        >
          Cancelar y regresar
        </button>
      </div>
    </div>

    <!-- ───────────── STEP 2: Review ───────────── -->
    <div v-else-if="step === 2" class="space-y-4">
      <div
        class="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden"
      >
        <div
          class="flex items-center justify-between px-6 py-4 border-b border-slate-100"
        >
          <h3 class="font-bold text-slate-800">
            {{ orderLines.length }} ítems encontrados
          </h3>
          <span class="text-sm text-slate-500"
            >Ajusta cantidades y selecciona productos</span
          >
        </div>

        <div class="divide-y divide-slate-100">
          <div v-for="(line, idx) in orderLines" :key="idx" class="px-6 py-4">
            <div class="flex flex-wrap items-start gap-3">
              <!-- Item number -->
              <div
                class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-xs font-bold text-slate-600"
              >
                {{ idx + 1 }}
              </div>

              <div class="min-w-0 flex-1 space-y-3">
                <!-- Raw text -->
                <p class="text-xs text-slate-400 font-mono">
                  {{ line.matched.raw }}
                </p>

                <!-- Selected product + qty -->
                <div class="flex flex-wrap items-center gap-2">
                  <!-- Qty input -->
                  <div
                    class="flex items-center gap-1 rounded-lg border border-slate-200 bg-white"
                  >
                    <button
                      class="px-2 py-1.5 text-slate-500 hover:text-indigo-600 transition"
                      @click="line.qty = Math.max(1, line.qty - 1)"
                    >
                      −
                    </button>
                    <input
                      v-model.number="line.qty"
                      type="number"
                      min="1"
                      class="w-12 text-center text-sm font-bold text-slate-800 outline-none"
                    />
                    <button
                      class="px-2 py-1.5 text-slate-500 hover:text-indigo-600 transition"
                      @click="line.qty++"
                    >
                      +
                    </button>
                  </div>

                  <!-- Stock badge -->
                  <span
                    class="rounded-full px-2.5 py-0.5 text-xs font-semibold"
                    :class="stockBadge(line).cls"
                  >
                    {{ stockBadge(line).label }}
                  </span>
                </div>

                <!-- Product options -->
                <div
                  v-if="line.selected || line.matched.alternatives.length"
                  class="space-y-1"
                >
                  <!-- Best match -->
                  <button
                    v-if="line.matched.best_match"
                    class="w-full flex items-center justify-between gap-3 rounded-xl border-2 px-3 py-2.5 text-left transition-all"
                    :class="
                      line.selected?.product_id ===
                      line.matched.best_match.product_id
                        ? 'border-indigo-500 bg-indigo-50'
                        : 'border-slate-200 bg-white hover:border-indigo-200'
                    "
                    @click="selectProduct(idx, line.matched.best_match)"
                  >
                    <div>
                      <p class="text-sm font-semibold text-slate-800">
                        {{ line.matched.best_match.name }}
                      </p>
                      <p class="text-xs text-slate-500">
                        {{ line.matched.best_match.unit }} · Stock:
                        {{ line.matched.best_match.stock_on_hand }}
                      </p>
                    </div>
                    <div class="text-right shrink-0">
                      <p class="text-sm font-bold text-indigo-700">
                        {{ formatMoney(line.matched.best_match.sale_price) }}
                      </p>
                      <p class="text-xs text-slate-400">c/u</p>
                    </div>
                  </button>

                  <!-- Alternatives -->
                  <div
                    v-if="line.matched.alternatives.length"
                    class="pl-4 space-y-1"
                  >
                    <p
                      class="text-[11px] font-bold uppercase tracking-wide text-slate-400 mb-1"
                    >
                      Otras opciones
                    </p>
                    <button
                      v-for="alt in line.matched.alternatives"
                      :key="alt.product_id"
                      class="w-full flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left transition-all"
                      :class="
                        line.selected?.product_id === alt.product_id
                          ? 'border-indigo-400 bg-indigo-50'
                          : 'border-slate-200 bg-white hover:border-indigo-200'
                      "
                      @click="selectProduct(idx, alt)"
                    >
                      <div>
                        <p class="text-xs font-semibold text-slate-700">
                          {{ alt.name }}
                        </p>
                        <p class="text-[11px] text-slate-400">
                          {{ alt.unit }} · Stock: {{ alt.stock_on_hand }}
                        </p>
                      </div>
                      <p class="text-xs font-bold text-slate-600 shrink-0">
                        {{ formatMoney(alt.sale_price) }}
                      </p>
                    </button>
                  </div>

                  <!-- No match -->
                  <div
                    v-if="!line.matched.best_match"
                    class="rounded-xl border border-dashed border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-600"
                  >
                    ❌ No encontramos "{{ line.matched.requested_item }}" en
                    stock. Puedes buscarlo manualmente en ventas.
                  </div>
                </div>
              </div>

              <!-- Subtotal -->
              <div class="text-right shrink-0">
                <p class="text-xs text-slate-400">Subtotal</p>
                <p class="text-sm font-bold text-slate-800">
                  {{ formatMoney((line.selected?.sale_price ?? 0) * line.qty) }}
                </p>
              </div>
            </div>
          </div>
        </div>

        <!-- Total footer -->
        <div
          class="flex items-center justify-between border-t border-slate-100 bg-slate-50 px-6 py-4"
        >
          <span class="text-sm text-slate-500">
            {{ validLines.length }} de {{ orderLines.length }} ítems con
            producto asignado
          </span>
          <div class="text-right">
            <p class="text-xs text-slate-400 uppercase tracking-wide font-bold">
              Total estimado
            </p>
            <p class="text-2xl font-black text-indigo-700">
              {{ formatMoney(orderTotal) }}
            </p>
          </div>
        </div>
      </div>

      <!-- Navigation -->
      <div class="flex justify-between">
        <button class="ui-btn-secondary" @click="goBack">← Volver</button>
        <button
          class="ui-btn !h-11 !px-8"
          :disabled="!validLines.length"
          @click="goToStep3"
        >
          Personalizar empaque →
        </button>
      </div>
    </div>

    <!-- ───────────── STEP 3: Customize ───────────── -->
    <div v-else-if="step === 3" class="space-y-4">
      <div
        class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm space-y-6"
      >
        <h3 class="font-extrabold text-slate-800 text-lg">
          Personalizar presentación
        </h3>

        <!-- Cover color -->
        <div>
          <p class="mb-3 text-sm font-bold text-slate-700">
            Color de forro de cuadernos
          </p>
          <div class="flex flex-wrap gap-2">
            <button
              v-for="c in coverColors"
              :key="c.id"
              class="flex items-center gap-2 rounded-full border-2 px-3 py-1.5 text-xs font-semibold transition-all"
              :class="
                coverColor === c.id
                  ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                  : 'border-slate-200 text-slate-600 hover:border-indigo-200'
              "
              @click="coverColor = c.id"
            >
              <span
                class="h-4 w-4 rounded-full border border-white shadow-sm shrink-0"
                :style="{ backgroundColor: c.hex }"
              />
              {{ c.label }}
            </button>
          </div>
        </div>

        <!-- Box type -->
        <div>
          <p class="mb-3 text-sm font-bold text-slate-700">Tipo de empaque</p>
          <div class="flex flex-wrap gap-2">
            <button
              v-for="t in [
                { id: 'bolsa', label: '🛍️ Bolsa', desc: 'Bolsa resistente' },
                { id: 'caja', label: '📦 Caja', desc: 'Caja decorada' },
                {
                  id: 'sin_empaque',
                  label: '📋 Sin empaque',
                  desc: 'Solo el pedido',
                },
              ]"
              :key="t.id"
              class="rounded-xl border-2 px-4 py-3 text-left transition-all"
              :class="
                boxType === t.id
                  ? 'border-indigo-500 bg-indigo-50'
                  : 'border-slate-200 bg-white hover:border-indigo-200'
              "
              @click="setBoxType(t.id)"
            >
              <p class="text-sm font-bold text-slate-800">{{ t.label }}</p>
              <p class="text-xs text-slate-500">{{ t.desc }}</p>
            </button>
          </div>
        </div>

        <!-- Box color (only if not sin_empaque) -->
        <div v-if="boxType !== 'sin_empaque'">
          <p class="mb-3 text-sm font-bold text-slate-700">
            Color de {{ boxTypeLabel.toLowerCase() }}
          </p>
          <div class="flex flex-wrap gap-2">
            <button
              v-for="c in boxColors"
              :key="c.id"
              class="flex items-center gap-2 rounded-full border-2 px-3 py-1.5 text-xs font-semibold transition-all"
              :class="
                boxColor === c.id
                  ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                  : 'border-slate-200 text-slate-600 hover:border-indigo-200'
              "
              @click="boxColor = c.id"
            >
              <span
                class="h-4 w-4 rounded-full border border-slate-200 shadow-sm shrink-0"
                :style="{ backgroundColor: c.hex }"
              />
              {{ c.label }}
            </button>
          </div>
        </div>

        <!-- Student name -->
        <div>
          <div class="flex items-center gap-3 mb-3">
            <button
              class="relative h-6 w-11 rounded-full transition-colors duration-300"
              :class="addStudentName ? 'bg-indigo-600' : 'bg-slate-300'"
              @click="addStudentName = !addStudentName"
            >
              <span
                class="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-300"
                :class="addStudentName ? 'left-5' : 'left-0.5'"
              />
            </button>
            <p class="text-sm font-bold text-slate-700">
              Agregar nombre del alumno
            </p>
          </div>
          <input
            v-if="addStudentName"
            v-model="studentName"
            type="text"
            placeholder="Ej: María González – 3° Primaria"
            class="ui-input w-full max-w-md"
          />
        </div>
      </div>

      <!-- Navigation -->
      <div class="flex justify-between">
        <button class="ui-btn-secondary" @click="goBack">← Volver</button>
        <button class="ui-btn !h-11 !px-8" @click="goToStep4">
          Ver vista previa →
        </button>
      </div>
    </div>

    <!-- ───────────── STEP 4: Preview ───────────── -->
    <div v-else-if="step === 4" class="space-y-4">
      <!-- Visual box preview -->
      <div class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h3 class="mb-4 font-extrabold text-slate-800 text-lg">
          Vista previa del pedido
        </h3>

        <div
          class="flex flex-col items-center gap-6 lg:flex-row lg:items-start"
        >
          <!-- Isometric box / bag SVG -->
          <div class="flex flex-col items-center gap-3 shrink-0">
            <!-- Box SVG -->
            <svg
              v-if="boxType !== 'sin_empaque'"
              width="220"
              height="200"
              viewBox="0 0 220 200"
              class="drop-shadow-2xl"
            >
              <!-- Back panel -->
              <polygon
                points="110,20 200,65 200,145 110,100"
                :fill="boxColorHex"
                :stroke="'color-mix(in srgb,' + boxColorHex + ' 60%, #000)'"
                stroke-width="1.5"
                opacity="0.8"
              />
              <!-- Left panel -->
              <polygon
                points="110,20 20,65 20,145 110,100"
                :fill="boxColorHex"
                :stroke="'color-mix(in srgb,' + boxColorHex + ' 60%, #000)'"
                stroke-width="1.5"
                opacity="0.6"
              />
              <!-- Top lid -->
              <polygon
                points="110,20 200,65 110,110 20,65"
                :fill="boxColorHex"
                :stroke="'color-mix(in srgb,' + boxColorHex + ' 60%, #000)'"
                stroke-width="1.5"
              />
              <!-- Items peeking out of box top - pencils -->
              <rect x="95" y="5" width="5" height="35" rx="2" fill="#F59E0B" />
              <rect x="105" y="8" width="5" height="30" rx="2" fill="#EF4444" />
              <rect x="115" y="3" width="5" height="38" rx="2" fill="#3B82F6" />
              <!-- Ruler peeking -->
              <rect x="82" y="10" width="3" height="25" rx="1" fill="#10B981" />

              <!-- Label on box if student name -->
              <g v-if="addStudentName && studentName">
                <rect
                  x="60"
                  y="120"
                  width="100"
                  height="20"
                  rx="4"
                  fill="white"
                  opacity="0.7"
                />
                <text
                  x="110"
                  y="134"
                  text-anchor="middle"
                  font-size="7"
                  fill="#1E293B"
                  font-weight="bold"
                >
                  {{ studentName.slice(0, 18)
                  }}{{ studentName.length > 18 ? "…" : "" }}
                </text>
              </g>

              <!-- Bag handles if bolsa -->
              <template v-if="boxType === 'bolsa'">
                <path
                  d="M90,20 Q90,0 110,0 Q130,0 130,20"
                  fill="none"
                  :stroke="boxColorHex"
                  stroke-width="5"
                  stroke-linecap="round"
                />
              </template>
            </svg>

            <!-- No packaging -->
            <div
              v-else
              class="flex h-40 w-48 flex-col items-center justify-center rounded-2xl border-2 border-dashed border-slate-300 bg-slate-50"
            >
              <svg
                class="h-10 w-10 text-slate-300"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="1.5"
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
              <p class="mt-2 text-sm text-slate-400 font-medium">
                Pedido sin empaque
              </p>
            </div>

            <!-- Summary chips -->
            <div class="flex flex-wrap justify-center gap-2">
              <span
                v-if="boxType !== 'sin_empaque'"
                class="flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-600 shadow-sm"
              >
                <span
                  class="h-3 w-3 rounded-full border border-slate-200 shrink-0"
                  :style="{ backgroundColor: boxColorHex }"
                />
                {{ boxTypeLabel }} {{ boxColor }}
              </span>
              <span
                v-if="coverColor"
                class="flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-600 shadow-sm"
              >
                <span
                  class="h-3 w-3 rounded-full border border-slate-200 shrink-0"
                  :style="{ backgroundColor: coverColorHex }"
                />
                Forro {{ coverColor }}
              </span>
              <span
                v-if="addStudentName && studentName"
                class="flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-600 shadow-sm"
              >
                👤 {{ studentName.slice(0, 20) }}
              </span>
            </div>
          </div>

          <!-- Items table -->
          <div class="flex-1 min-w-0 w-full">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-slate-100">
                  <th
                    class="pb-2 text-left text-xs font-extrabold uppercase tracking-wide text-slate-400"
                  >
                    Producto
                  </th>
                  <th
                    class="pb-2 text-center text-xs font-extrabold uppercase tracking-wide text-slate-400"
                  >
                    Cant.
                  </th>
                  <th
                    class="pb-2 text-right text-xs font-extrabold uppercase tracking-wide text-slate-400"
                  >
                    Precio
                  </th>
                  <th
                    class="pb-2 text-right text-xs font-extrabold uppercase tracking-wide text-slate-400"
                  >
                    Subtotal
                  </th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-50">
                <tr v-for="(line, idx) in validLines" :key="idx">
                  <td class="py-2.5 pr-4">
                    <p class="font-semibold text-slate-800">
                      {{ line.selected?.name }}
                    </p>
                    <p class="text-xs text-slate-400">
                      {{ line.selected?.unit }}
                    </p>
                  </td>
                  <td class="py-2.5 text-center font-bold text-slate-700">
                    {{ line.qty }}
                  </td>
                  <td class="py-2.5 text-right text-slate-600">
                    {{ formatMoney(line.selected?.sale_price) }}
                  </td>
                  <td class="py-2.5 text-right font-bold text-slate-800">
                    {{
                      formatMoney((line.selected?.sale_price || 0) * line.qty)
                    }}
                  </td>
                </tr>
              </tbody>
              <tfoot>
                <tr class="border-t-2 border-slate-200">
                  <td
                    colspan="3"
                    class="pt-3 text-right text-sm font-bold text-slate-500 uppercase tracking-wide"
                  >
                    Total
                  </td>
                  <td
                    class="pt-3 text-right text-xl font-black text-indigo-700"
                  >
                    {{ formatMoney(orderTotal) }}
                  </td>
                </tr>
              </tfoot>
            </table>

            <!-- Skipped items warning -->
            <div
              v-if="orderLines.length > validLines.length"
              class="mt-3 rounded-xl bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-700"
            >
              ⚠️ {{ orderLines.length - validLines.length }} ítem(s) sin
              producto asignado no se incluirán en el pedido.
            </div>
          </div>
        </div>
      </div>

      <!-- Price comparison table (alternatives) -->
      <div
        v-if="orderLines.some((l) => l.matched.alternatives.length)"
        class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <h3 class="mb-3 font-bold text-slate-800">
          💰 Comparación de precios por marca
        </h3>
        <div class="space-y-3">
          <div
            v-for="(line, idx) in orderLines.filter(
              (l) => l.matched.alternatives.length,
            )"
            :key="idx"
            class="rounded-xl border border-slate-100 bg-slate-50 p-3"
          >
            <p
              class="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500"
            >
              {{ line.matched.requested_item }}
            </p>
            <div class="flex flex-wrap gap-2">
              <div
                v-if="line.matched.best_match"
                class="flex items-center gap-2 rounded-lg bg-white border border-slate-200 px-3 py-2 shadow-sm"
              >
                <div>
                  <p class="text-xs font-semibold text-slate-700">
                    {{ line.matched.best_match.name }}
                  </p>
                  <p class="text-xs text-slate-400">
                    Stock: {{ line.matched.best_match.stock_on_hand }}
                  </p>
                </div>
                <p class="text-sm font-black text-indigo-700 ml-2">
                  {{ formatMoney(line.matched.best_match.sale_price) }}
                </p>
              </div>
              <div
                v-for="alt in line.matched.alternatives"
                :key="alt.product_id"
                class="flex items-center gap-2 rounded-lg bg-white border border-slate-200 px-3 py-2 shadow-sm"
              >
                <div>
                  <p class="text-xs font-semibold text-slate-700">
                    {{ alt.name }}
                  </p>
                  <p class="text-xs text-slate-400">
                    Stock: {{ alt.stock_on_hand }}
                  </p>
                </div>
                <p class="text-sm font-black text-slate-600 ml-2">
                  {{ formatMoney(alt.sale_price) }}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Navigation -->
      <div class="flex flex-wrap items-center justify-between gap-3">
        <button class="ui-btn-secondary" @click="goBack">← Volver</button>
        <div class="flex gap-3">
          <button class="ui-btn-secondary" @click="resetAll">
            🔄 Nuevo pedido
          </button>
          <button class="ui-btn !h-11 !px-8" @click="sendToCart">
            🛒 Enviar al carrito de ventas
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
