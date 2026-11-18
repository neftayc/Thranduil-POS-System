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
  id?: string;
  brand_id?: string;
  sku: string;
  name: string;
  brand?: string | null;
  unit: string;
  base_unit?: string | null;
  sale_price: number;
  factor_to_base?: number;
  pricing_label?: string | null;
  pricing_rule_id?: string | null;
  stock_on_hand: number;
  score: number;
};

type SearchProductOption = {
  id: string;
  sku: string;
  name: string;
  brand: string | null;
  unit: string;
  sale_price: number;
  stock_on_hand: number;
};

type ItemBrandRecord = {
  id: string;
  item_id: string;
  brand: string;
  is_default: boolean;
  product_id: string;
  product_name: string | null;
  pricing_rule_id?: string | null;
  pricing_unit_name?: string | null;
  pricing_label?: string | null;
  pricing_price_uom?: number | null;
  pricing_factor_to_base?: number | null;
};

type PresentationPriceOption = {
  key: string;
  rule_id: string | null;
  unit_name: string;
  factor_to_base: number | null;
  price_uom: number;
  label: string;
  helper: string | null;
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
type AnalysisVariantKey = "default" | "economic" | "premium";

// ─── State ───────────────────────────────────────────────────────────────────
const step = ref<Step>(0);
const loading = ref(false);
const error = ref("");
const successMessage = ref("");

const linkedEditorItemId = ref("");
const linkedEditorQuery = ref("");
const linkedEditorResults = ref<SearchProductOption[]>([]);
const linkedEditorLoading = ref(false);
const linkedEditorSavingItemId = ref("");

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
const presentationOptionsByProductId = ref<
  Record<string, PresentationPriceOption[]>
>({});
const presentationOptionsLoadingProductId = ref("");
const presentationPriceSavingBrandId = ref("");
let linkedEditorSearchTimer: ReturnType<typeof setTimeout> | null = null;
const SCHOOL_MISSING_ITEMS_TOLERANCE_PCT = 0.2;
const ANALYSIS_VARIANTS: AnalysisVariantKey[] = [
  "default",
  "economic",
  "premium",
];

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

const loadListAnalysis = async (listId: string, scrollToTop = true) => {
  dashLoading.value = true;
  error.value = "";
  successMessage.value = "";
  try {
    selectedListAnalysis.value = await $fetch<any>(
      `/api/school/stock-analysis?list_id=${listId}`,
    );
    activeDashboardTab.value = "detail";
    if (scrollToTop && import.meta.client) {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  } catch (err: any) {
    error.value = "Error cargando detalle: " + err.message;
  } finally {
    dashLoading.value = false;
  }
};

const viewListDetail = async (listId: string) => {
  await loadListAnalysis(listId);
};

const refreshSelectedListAnalysis = async () => {
  const listId = selectedListAnalysis.value?.list?.id;
  if (!listId) return;
  await loadListAnalysis(listId, false);
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
        requested_qty: Number(variantData.qty_uom || item.qty || 0),
        raw: item.description,
        best_match: variantData.linked_product,
        alternatives: variantData.linked_product
          ? [variantData.linked_product]
          : [],
        stock_status: variantData.match_status,
      },
      qty: Number(variantData.qty_uom || item.qty || 0),
      selected: variantData.linked_product,
    };
  });
  step.value = 2;
};

onMounted(() => {
  loadDashboard();
});

watch(selectedVariant, () => {
  closeLinkedProductEditor();
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
const selectedVariantLabel = computed(
  () =>
    ({
      default: "Recomendado",
      economic: "Económico",
      premium: "Premium",
    })[selectedVariant.value],
);
const groupedListsByInstitution = computed(() => {
  const groups: Array<{
    key: string;
    institutionName: string;
    totalLists: number;
    totalRealizable: number;
    lists: any[];
  }> = [];
  const groupIndexByKey = new Map<string, number>();

  for (const list of allListsStock.value) {
    const institutionName =
      String(list?.institution_name || "").trim() || "Sin institución";
    const key = institutionName.toLowerCase();
    const existingIndex = groupIndexByKey.get(key);

    if (typeof existingIndex === "number") {
      const group = groups[existingIndex];
      group.lists.push(list);
      group.totalLists += 1;
      group.totalRealizable += toFiniteNumber(list?.realizable_value);
      continue;
    }

    groupIndexByKey.set(key, groups.length);
    groups.push({
      key,
      institutionName,
      totalLists: 1,
      totalRealizable: toFiniteNumber(list?.realizable_value),
      lists: [list],
    });
  }

  return groups;
});

const boxTypeLabel = computed(() => {
  if (boxType.value === "bolsa") return "Bolsa";
  if (boxType.value === "caja") return "Caja";
  return "Sin empaque";
});

// ─── Helpers ─────────────────────────────────────────────────────────────────
const formatMoney = (v: number) => `S/ ${Number(v).toFixed(2)}`;
const profitTextClass = (value: number) =>
  Number(value || 0) >= 0 ? "text-emerald-600" : "text-rose-600";
const toFiniteNumber = (value: unknown, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const calculateCompletableSetsWithTolerance = (
  setsPerItem: number[],
  totalItems: number,
) => {
  if (!setsPerItem.length || totalItems <= 0) return 0;
  const allowedMissingItems = Math.min(
    setsPerItem.length - 1,
    Math.ceil(totalItems * SCHOOL_MISSING_ITEMS_TOLERANCE_PCT),
  );
  const sortedSets = [...setsPerItem].sort((a, b) => a - b);
  return Math.max(0, sortedSets[allowedMissingItems] ?? 0);
};
const calculateListScore = (list: any) =>
  toFiniteNumber(list?.realizable_value) * 0.5 +
  toFiniteNumber(list?.coverage_pct) * 10 +
  toFiniteNumber(list?.completable_sets) * 5;

const escapeHtml = (value: unknown) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const getActiveVariant = (item: any) => item?.variants?.[selectedVariant.value] || null;
const getLinkedProduct = (item: any) => getActiveVariant(item)?.linked_product || null;
const getProfitTotal = (item: any) => Number(getActiveVariant(item)?.profit_total || 0);
const getSelectedPresentationKey = (item: any) => {
  const linkedProduct = getLinkedProduct(item);
  if (!linkedProduct) return "base";
  const ruleId = String(linkedProduct.pricing_rule_id || "").trim();
  return ruleId ? `presentation:${ruleId}` : "base";
};
const getPresentationOptions = (item: any) => {
  const linkedProduct = getLinkedProduct(item);
  const productId = String(linkedProduct?.product_id || linkedProduct?.id || "").trim();
  if (!linkedProduct || !productId) return [];
  return presentationOptionsByProductId.value[productId] || [
    {
      key: getSelectedPresentationKey(item),
      rule_id: linkedProduct.pricing_rule_id || null,
      unit_name: linkedProduct.unit || linkedProduct.base_unit || "unidad",
      factor_to_base: Number(linkedProduct.factor_to_base || 1),
      price_uom: Number(linkedProduct.sale_price || 0),
      label:
        linkedProduct.pricing_label ||
        `Base (${linkedProduct.base_unit || linkedProduct.unit || "unidad"})`,
      helper: null,
    },
  ];
};
const getCompatiblePresentationOptions = (item: any) => {
  return getPresentationOptions(item);
};
const getPresentationOptionDisabledReason = (
  item: any,
  option: PresentationPriceOption,
) => {
  if (option.key === "base") return "";
  const factor = Number(option.factor_to_base || 0);
  if (!Number.isFinite(factor) || factor <= 0) {
    return "Falta conversion";
  }
  const qtyBase = Number(item?.qty || 0);
  const qtyUom = qtyBase / factor;
  if (Math.abs(qtyUom - Math.round(qtyUom)) >= 0.000001) {
    return `No calza con ${qtyBase}`;
  }
  return "";
};
const isPresentationOptionSelectable = (
  item: any,
  option: PresentationPriceOption,
) => !getPresentationOptionDisabledReason(item, option);
const getSelectedPresentationHelper = (item: any) => {
  const selectedKey = getSelectedPresentationKey(item);
  const option = getPresentationOptions(item).find((entry) => entry.key === selectedKey);
  if (!option) return getLinkedProduct(item)?.pricing_label || "Base";
  const reason = getPresentationOptionDisabledReason(item, option);
  if (reason) return `${option.label} · ${reason}`;
  return option.helper || option.label;
};
const pricingConfigRoute = (productId: string | null | undefined) => ({
  path: "/pricing",
  query: { product_id: String(productId || "") },
});

const stockBadge = (line: OrderLine) => {
  if (!line.selected)
    return { label: "Sin match", cls: "bg-rose-100 text-rose-700" };
  const avail = line.selected.stock_on_hand;
  const qtyBase = Number(line.qty || 0) * Number(line.selected.factor_to_base || 1);
  if (avail <= 0)
    return { label: "Sin stock", cls: "bg-rose-100 text-rose-700" };
  if (avail < qtyBase)
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

const closeLinkedProductEditor = () => {
  linkedEditorItemId.value = "";
  linkedEditorQuery.value = "";
  linkedEditorResults.value = [];
  linkedEditorLoading.value = false;
  if (linkedEditorSearchTimer) clearTimeout(linkedEditorSearchTimer);
};

const searchLinkedProducts = () => {
  if (linkedEditorSearchTimer) clearTimeout(linkedEditorSearchTimer);

  const q = linkedEditorQuery.value.trim();
  if (q.length < 2) {
    linkedEditorResults.value = [];
    linkedEditorLoading.value = false;
    return;
  }

  linkedEditorLoading.value = true;
  linkedEditorSearchTimer = setTimeout(async () => {
    try {
      const data = await $fetch<SearchProductOption[]>("/api/products/search", {
        query: { q },
      });
      linkedEditorResults.value = data || [];
    } catch {
      linkedEditorResults.value = [];
    } finally {
      linkedEditorLoading.value = false;
    }
  }, 250);
};

const openLinkedProductEditor = (item: any) => {
  linkedEditorItemId.value = item.id;
  linkedEditorQuery.value =
    getLinkedProduct(item)?.name || item.description || item.notes || "";
  linkedEditorResults.value = [];
  error.value = "";
  successMessage.value = "";
  searchLinkedProducts();
};

const ensurePresentationOptions = async (item: any) => {
  const linkedProduct = getLinkedProduct(item);
  const productId = String(linkedProduct?.product_id || linkedProduct?.id || "").trim();
  if (!productId || presentationOptionsByProductId.value[productId]) return;

  presentationOptionsLoadingProductId.value = productId;
  try {
    const res = await $fetch<{
      options: PresentationPriceOption[];
    }>(`/api/school/presentation-prices?product_id=${encodeURIComponent(productId)}`);
    presentationOptionsByProductId.value = {
      ...presentationOptionsByProductId.value,
      [productId]: res?.options?.length ? res.options : getPresentationOptions(item),
    };
  } catch (err: any) {
    error.value =
      err?.data?.statusMessage ||
      err?.message ||
      "No se pudieron cargar los precios por presentación.";
  } finally {
    presentationOptionsLoadingProductId.value = "";
  }
};

const refreshDashboardBadgesLocally = () => {
  const nextLists = allListsStock.value
    .map((list: any) => ({
      ...list,
      score: calculateListScore(list),
      badge: null,
    }))
    .sort((a: any, b: any) => toFiniteNumber(b.score) - toFiniteNumber(a.score));

  if (nextLists.length > 0 && toFiniteNumber(nextLists[0].score) > 0) {
    nextLists[0].badge = "⭐ Mayor retorno";
  }

  nextLists.forEach((list: any, index: number) => {
    if (index > 0 && list.coverage_pct >= 80 && list.completable_sets === 0) {
      list.badge = list.badge || "📦 Sugiere restock";
    }
    if (index > 0 && list.completable_sets >= 10) {
      list.badge = list.badge || "🔥 Alta rotación";
    }
  });

  allListsStock.value = nextLists;
};

const syncDashboardEntryFromCurrentAnalysis = () => {
  const analysis = selectedListAnalysis.value;
  const selectedListId = String(analysis?.list?.id || "").trim();
  if (!selectedListId) return;

  const entryIndex = allListsStock.value.findIndex(
    (list: any) => String(list?.id || "").trim() === selectedListId,
  );
  if (entryIndex < 0) return;

  const currentEntry = allListsStock.value[entryIndex];
  const nextEntry = {
    ...currentEntry,
    institution_name:
      analysis?.list?.institution_name || currentEntry?.institution_name,
    grade_name: analysis?.list?.grade_name || currentEntry?.grade_name,
    grade_level: analysis?.list?.grade_level || currentEntry?.grade_level,
    section_name: analysis?.list?.section_name || currentEntry?.section_name,
    year: analysis?.list?.year || currentEntry?.year,
    total_price: toFiniteNumber(analysis?.metrics?.default?.total_price),
    price_min: toFiniteNumber(analysis?.metrics?.economic?.total_price),
    price_max: toFiniteNumber(analysis?.metrics?.premium?.total_price),
    completable_sets: toFiniteNumber(
      analysis?.metrics?.default?.completable_sets,
    ),
    realizable_value: toFiniteNumber(
      analysis?.metrics?.default?.realizable_value,
    ),
    coverage_pct: toFiniteNumber(analysis?.metrics?.default?.coverage_pct),
    total_items: toFiniteNumber(analysis?.metrics?.total_items),
    items_with_product: toFiniteNumber(
      analysis?.metrics?.default?.items_with_product,
    ),
  };

  nextEntry.score = calculateListScore(nextEntry);
  allListsStock.value.splice(entryIndex, 1, nextEntry);
  refreshDashboardBadgesLocally();
};

const refreshSingleListItemAnalysis = async (itemId: string) => {
  const listId = String(selectedListAnalysis.value?.list?.id || "").trim();
  if (!listId) return false;

  const latestAnalysis = await $fetch<any>(
    `/api/school/stock-analysis?list_id=${encodeURIComponent(listId)}`,
  );
  const updatedItem = latestAnalysis?.items?.find(
    (entry: any) => String(entry?.id || "").trim() === String(itemId || "").trim(),
  );
  const currentItems = selectedListAnalysis.value?.items;
  if (!updatedItem || !Array.isArray(currentItems)) return false;

  const itemIndex = currentItems.findIndex(
    (entry: any) => String(entry?.id || "").trim() === String(itemId || "").trim(),
  );
  if (itemIndex < 0) return false;

  currentItems.splice(itemIndex, 1, updatedItem);
  selectedListAnalysis.value.metrics = latestAnalysis.metrics;
  syncDashboardEntryFromCurrentAnalysis();
  return true;
};

const recalculateSelectedListMetricsLocally = () => {
  const analysis = selectedListAnalysis.value;
  if (!analysis?.items?.length || !analysis?.metrics) return;

  const totalItems = analysis.items.length;
  const setsPerVariant: Record<AnalysisVariantKey, number[]> = {
    default: [],
    economic: [],
    premium: [],
  };
  const nextMetrics: Record<AnalysisVariantKey, any> = {
    default: {
      total_price: 0,
      total_cost: 0,
      total_profit: 0,
      completable_sets: 0,
      realizable_value: 0,
      coverage_pct: 0,
      items_with_product: 0,
    },
    economic: {
      total_price: 0,
      total_cost: 0,
      total_profit: 0,
      completable_sets: 0,
      realizable_value: 0,
      coverage_pct: 0,
      items_with_product: 0,
    },
    premium: {
      total_price: 0,
      total_cost: 0,
      total_profit: 0,
      completable_sets: 0,
      realizable_value: 0,
      coverage_pct: 0,
      items_with_product: 0,
    },
  };

  for (const analysisItem of analysis.items) {
    const qtyNeeded = Math.max(toFiniteNumber(analysisItem?.qty, 0) || 1, 1);

    for (const variantKey of ANALYSIS_VARIANTS) {
      const variant = analysisItem?.variants?.[variantKey];
      const linkedProduct = variant?.linked_product;

      nextMetrics[variantKey].total_price += toFiniteNumber(variant?.subtotal);
      nextMetrics[variantKey].total_cost += toFiniteNumber(variant?.cost_total);
      nextMetrics[variantKey].total_profit += toFiniteNumber(
        variant?.profit_total,
      );

      if (linkedProduct) {
        nextMetrics[variantKey].items_with_product += 1;
        const stockOnHand = Math.max(
          toFiniteNumber(linkedProduct?.stock_on_hand),
          0,
        );
        setsPerVariant[variantKey].push(Math.floor(stockOnHand / qtyNeeded));
      } else {
        setsPerVariant[variantKey].push(0);
      }
    }
  }

  for (const variantKey of ANALYSIS_VARIANTS) {
    const completableSets = calculateCompletableSetsWithTolerance(
      setsPerVariant[variantKey],
      totalItems,
    );
    nextMetrics[variantKey].completable_sets = completableSets;
    nextMetrics[variantKey].realizable_value =
      completableSets * nextMetrics[variantKey].total_price;
    nextMetrics[variantKey].coverage_pct = totalItems > 0
      ? (nextMetrics[variantKey].items_with_product / totalItems) * 100
      : 0;
  }

  analysis.metrics = {
    ...analysis.metrics,
    ...nextMetrics,
    total_items: totalItems,
  };
  syncDashboardEntryFromCurrentAnalysis();
};

const applyPresentationPriceLocally = (
  itemId: string,
  brandId: string,
  option: PresentationPriceOption,
) => {
  const analysis = selectedListAnalysis.value;
  if (!analysis?.items?.length) return;

  const normalizedItemId = String(itemId || "").trim();
  const normalizedBrandId = String(brandId || "").trim();
  const factorToBase = Math.max(toFiniteNumber(option.factor_to_base, 1), 1);
  const salePrice = Math.max(toFiniteNumber(option.price_uom), 0);
  let updated = false;

  for (const analysisItem of analysis.items) {
    if (String(analysisItem?.id || "").trim() !== normalizedItemId) continue;

    const qtyNeeded = toFiniteNumber(analysisItem?.qty, 0) || 1;
    const qtyUom = factorToBase > 0 ? qtyNeeded / factorToBase : qtyNeeded;

    for (const variantKey of ANALYSIS_VARIANTS) {
      const variant = analysisItem?.variants?.[variantKey];
      const linkedProduct = variant?.linked_product;
      if (!variant || !linkedProduct) continue;
      if (String(linkedProduct?.brand_id || "").trim() !== normalizedBrandId) {
        continue;
      }

      linkedProduct.sale_price = salePrice;
      linkedProduct.unit =
        String(option.unit_name || "").trim() ||
        String(linkedProduct.base_unit || linkedProduct.unit || "unidad").trim() ||
        "unidad";
      linkedProduct.factor_to_base = factorToBase;
      linkedProduct.pricing_label = option.label;
      linkedProduct.pricing_rule_id = option.rule_id;

      variant.qty_uom = qtyUom;
      variant.factor_to_base = factorToBase;
      variant.unit_name = linkedProduct.unit;
      variant.subtotal = qtyUom * salePrice;
      variant.profit_total =
        variant.subtotal - toFiniteNumber(variant.cost_total);
      updated = true;
    }
  }

  if (updated) {
    recalculateSelectedListMetricsLocally();
  }
};

const applyPresentationPrice = async (item: any, optionKey: string) => {
  const linkedProduct = getLinkedProduct(item);
  const brandId = String(linkedProduct?.brand_id || "").trim();
  const productId = String(linkedProduct?.product_id || linkedProduct?.id || "").trim();
  if (!linkedProduct || !brandId || !productId) return;

  await ensurePresentationOptions(item);
  const option = getCompatiblePresentationOptions(item).find(
    (entry) => entry.key === optionKey,
  );
  if (!option || !isPresentationOptionSelectable(item, option)) return;

  presentationPriceSavingBrandId.value = brandId;
  error.value = "";
  successMessage.value = "";

  try {
    await $fetch("/api/school/item-brands", {
      method: "POST",
      body: {
        id: brandId,
        item_id: item.id,
        product_id: productId,
        brand: linkedProduct.brand || linkedProduct.name,
        pricing_rule_id: option.rule_id,
        pricing_unit_name: option.unit_name,
        pricing_label: option.label,
        pricing_price_uom: option.price_uom,
        pricing_factor_to_base: option.factor_to_base,
      },
    });
    applyPresentationPriceLocally(item.id, brandId, option);
    successMessage.value = "Precio de presentación actualizado.";
  } catch (err: any) {
    error.value =
      err?.data?.statusMessage ||
      err?.message ||
      "No se pudo actualizar el precio de presentación.";
  } finally {
    presentationPriceSavingBrandId.value = "";
  }
};

const onPresentationSelectChange = (item: any, event: Event) => {
  const target = event.target as HTMLSelectElement | null;
  if (!target) return;
  applyPresentationPrice(item, target.value);
};

const replaceLinkedProduct = async (
  item: any,
  product: SearchProductOption,
) => {
  linkedEditorSavingItemId.value = item.id;
  error.value = "";
  successMessage.value = "";

  try {
    const existingBrands = await $fetch<ItemBrandRecord[]>(
      `/api/school/item-brands?item_id=${item.id}`,
    );
    const currentBrand = existingBrands.find((brand) => brand.is_default) ||
      existingBrands[0];

    const savedBrand = await $fetch<ItemBrandRecord>("/api/school/item-brands", {
      method: "POST",
      body: {
        id: currentBrand?.id,
        item_id: item.id,
        product_id: product.id,
        brand: product.brand || product.name,
        is_default: true,
        pricing_rule_id: null,
        pricing_unit_name: product.unit || "unidad",
        pricing_label: `Base (${product.unit || "unidad"})`,
        pricing_price_uom: Number(product.sale_price || 0),
        pricing_factor_to_base: 1,
      },
    });

    const staleBrands = existingBrands.filter((brand) => brand.id !== savedBrand.id);
    for (const brand of staleBrands) {
      await $fetch(`/api/school/item-brands?id=${brand.id}`, {
        method: "DELETE",
      });
    }

    await refreshSingleListItemAnalysis(item.id);
    closeLinkedProductEditor();
    successMessage.value = "Producto vinculado actualizado.";
  } catch (err: any) {
    error.value =
      err?.data?.statusMessage ||
      err?.message ||
      "No se pudo actualizar el producto vinculado.";
  } finally {
    linkedEditorSavingItemId.value = "";
  }
};

const removeListItem = async (item: any) => {
  if (!item?.id) return;
  if (!confirm("¿Eliminar esta fila de la lista escolar?")) return;

  linkedEditorSavingItemId.value = item.id;
  error.value = "";
  successMessage.value = "";

  try {
    await $fetch(`/api/school/list-items?id=${item.id}`, {
      method: "DELETE",
    });
    closeLinkedProductEditor();
    await refreshSelectedListAnalysis();
    successMessage.value = "Fila eliminada correctamente.";
  } catch (err: any) {
    error.value =
      err?.data?.statusMessage ||
      err?.message ||
      "No se pudo eliminar la fila.";
  } finally {
    linkedEditorSavingItemId.value = "";
  }
};

const printSelectedList = () => {
  if (!selectedListAnalysis.value?.items?.length) {
    error.value = "No hay una lista cargada para imprimir.";
    return;
  }

  const generatedAt = new Intl.DateTimeFormat("es-PE", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date());

  const rows = selectedListAnalysis.value.items
    .map((item: any, index: number) => {
      const variant = item.variants?.[selectedVariant.value];
      const linkedProduct = variant?.linked_product;

      return `
        <tr>
          <td>${escapeHtml(index + 1)}</td>
          <td>
            <strong>${escapeHtml(item.description)}</strong>
            ${item.notes ? `<div class="note">${escapeHtml(item.notes)}</div>` : ""}
          </td>
          <td>${escapeHtml(item.qty)}</td>
          <td>
            ${linkedProduct ? escapeHtml(linkedProduct.name) : "No vinculado"}
            ${linkedProduct?.brand ? `<div class="note">${escapeHtml(linkedProduct.brand)}</div>` : ""}
          </td>
          <td>${linkedProduct ? escapeHtml(formatMoney(linkedProduct.sale_price)) : "-"}</td>
          <td>${linkedProduct ? escapeHtml(formatMoney(variant.subtotal)) : "-"}</td>
        </tr>
      `;
    })
    .join("");

  const html = `
    <html>
      <head>
        <meta charset="utf-8" />
        <title>Lista de útiles</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            padding: 24px;
            color: #0f172a;
          }
          h1 {
            margin: 0 0 6px;
            font-size: 24px;
          }
          p {
            margin: 0 0 6px;
            color: #475569;
            font-size: 13px;
          }
          .meta {
            margin-top: 4px;
            margin-bottom: 18px;
          }
          .summary {
            display: grid;
            grid-template-columns: repeat(3, minmax(0, 1fr));
            gap: 12px;
            margin-bottom: 18px;
          }
          .summary-card {
            border: 1px solid #cbd5e1;
            border-radius: 10px;
            padding: 10px 12px;
            background: #f8fafc;
          }
          .summary-card strong {
            display: block;
            font-size: 18px;
            margin-top: 4px;
            color: #0f172a;
          }
          table {
            width: 100%;
            border-collapse: collapse;
            font-size: 12px;
          }
          th, td {
            border: 1px solid #cbd5e1;
            padding: 8px;
            text-align: left;
            vertical-align: top;
          }
          th {
            background: #eef2ff;
            font-weight: 700;
          }
          .note {
            color: #64748b;
            font-size: 11px;
            margin-top: 2px;
          }
        </style>
      </head>
      <body>
        <h1>${escapeHtml(selectedListAnalysis.value.list.institution_name)}</h1>
        <p class="meta">
          ${escapeHtml(selectedListAnalysis.value.list.grade_name)} -
          ${escapeHtml(selectedListAnalysis.value.list.section_name)}
          (${escapeHtml(selectedListAnalysis.value.list.year)})<br />
          Variante impresa: ${escapeHtml(selectedVariantLabel.value)}<br />
          Generado: ${escapeHtml(generatedAt)}
        </p>

        <div class="summary">
          <div class="summary-card">
            Total lista
            <strong>${escapeHtml(formatMoney(selectedListAnalysis.value.metrics[selectedVariant.value].total_price))}</strong>
          </div>
          <div class="summary-card">
            Cobertura
            <strong>${escapeHtml(selectedListAnalysis.value.metrics[selectedVariant.value].coverage_pct.toFixed(0))}%</strong>
          </div>
          <div class="summary-card">
            Ítems
            <strong>${escapeHtml(selectedListAnalysis.value.metrics.total_items)}</strong>
          </div>
        </div>

        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Útil requerido</th>
              <th>Cant.</th>
              <th>Producto vinculado</th>
              <th>Precio unit.</th>
              <th>Subtotal</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </body>
    </html>
  `;

  const printWindow = window.open("", "_blank", "width=1280,height=900");
  if (!printWindow) {
    error.value = "No se pudo abrir la ventana de impresión.";
    return;
  }

  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();
  printWindow.focus();
  printWindow.print();
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
    factor_to_base: Number(line.selected!.factor_to_base || 1),
    qty: line.qty,
    auto_price_unit: line.selected!.sale_price,
    price_unit: line.selected!.sale_price,
    pricing_source: "utiles",
    pricing_detail: {
      source: "utiles",
      pricing_label: line.selected!.pricing_label || null,
      unit_name: line.selected!.unit,
      factor_to_base: Number(line.selected!.factor_to_base || 1),
      base_unit: line.selected!.base_unit || line.selected!.unit,
    },
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
      <div
        v-if="successMessage"
        class="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-700"
      >
        {{ successMessage }}
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
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 class="text-lg font-bold text-slate-800">
              Listas Disponibles (Stock Activo)
            </h3>
            <p class="text-sm text-slate-500">
              Agrupadas por institución para revisar y entrar más rápido.
            </p>
          </div>
          <div class="flex items-center gap-3">
            <span
              class="inline-flex rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700"
            >
              {{ groupedListsByInstitution.length }} instituciones
            </span>
            <button class="ui-btn-secondary" @click="step = 1">
              Crear pedido con IA/Texto
            </button>
          </div>
        </div>

        <div v-if="groupedListsByInstitution.length" class="space-y-6">
          <section
            v-for="group in groupedListsByInstitution"
            :key="group.key"
            class="space-y-3"
          >
            <div
              class="flex flex-wrap items-end justify-between gap-3 rounded-2xl border border-slate-200 bg-white/80 px-4 py-3 shadow-sm"
            >
              <div>
                <p
                  class="text-[11px] font-black uppercase tracking-[0.22em] text-indigo-500"
                >
                  Institución
                </p>
                <h4 class="text-lg font-extrabold text-slate-800">
                  {{ group.institutionName }}
                </h4>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <span
                  class="inline-flex rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-600"
                >
                  {{ group.totalLists }} listas
                </span>
                <span
                  class="inline-flex rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700"
                >
                  Valor realizable S/ {{ group.totalRealizable.toFixed(2) }}
                </span>
              </div>
            </div>

            <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div
                v-for="list in group.lists"
                :key="list.id"
                class="group relative cursor-pointer rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-indigo-300 hover:shadow-md"
                @click="viewListDetail(list.id)"
              >
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
                    <p class="h-4 text-xs font-medium text-slate-500">
                      Rango de Precios
                    </p>
                    <div class="mt-1 flex items-center gap-1.5">
                      <span class="text-base font-bold text-slate-800"
                        >S/ {{ list.price_min.toFixed(2) }}</span
                      >
                      <span class="text-xs text-slate-400">a</span>
                      <span class="text-base font-bold text-slate-800"
                        >S/ {{ list.price_max.toFixed(2) }}</span
                      >
                    </div>
                  </div>
                  <div class="col-span-2 mt-1 border-t border-slate-200/60"></div>
                  <div>
                    <p class="text-xs font-medium text-slate-500">
                      Cobertura stock
                    </p>
                    <p class="font-bold text-slate-800">
                      {{ list.coverage_pct.toFixed(0) }}% ítems listos
                    </p>
                  </div>
                  <div>
                    <p class="text-xs font-medium text-slate-500">
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
                    <p class="text-xs font-medium text-slate-500">
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
          </section>
        </div>
        <p v-else class="ui-empty-state">
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
            <button class="ui-btn-secondary" @click="printSelectedList">
              🖨️ Imprimir
            </button>
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
        <div class="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
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
            class="rounded-2xl border border-amber-200 bg-amber-50 p-5 shadow-sm"
          >
            <p
              class="text-xs font-semibold uppercase tracking-wider text-amber-700"
            >
              Costo Total Compra
            </p>
            <p class="mt-1 text-2xl font-black text-amber-800">
              {{
                formatMoney(
                  selectedListAnalysis.metrics[selectedVariant].total_cost,
                )
              }}
            </p>
            <p class="text-xs font-medium text-amber-700/80">
              Basado en costo real FIFO del inventario
            </p>
          </div>
          <div
            class="rounded-2xl border border-indigo-200 bg-indigo-50 p-5 shadow-sm"
          >
            <p
              class="text-xs font-semibold uppercase tracking-wider text-indigo-600"
            >
              Ganancia Estimada
            </p>
            <p
              class="mt-1 text-2xl font-black"
              :class="
                profitTextClass(
                  selectedListAnalysis.metrics[selectedVariant].total_profit,
                )
              "
            >
              {{
                formatMoney(
                  selectedListAnalysis.metrics[selectedVariant].total_profit,
                )
              }}
            </p>
            <p class="text-xs font-medium text-indigo-600/80">
              Venta menos costo total FIFO
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
            <div>
              <h4 class="font-bold text-slate-800">
                {{ selectedListAnalysis.metrics.total_items }} Útiles Requeridos
              </h4>
              <p class="mt-1 text-xs text-slate-500">
                Puedes reemplazar el producto vinculado o eliminar filas desde
                esta tabla.
              </p>
            </div>
            <button class="ui-btn-secondary px-3 py-2 text-sm" @click="printSelectedList">
              Imprimir
            </button>
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
                  <th class="px-6 py-3">Precio Seleccionable</th>
                  <th class="px-6 py-3">Estado Stock</th>
                  <th class="px-6 py-3 text-right">Precio Unit.</th>
                  <th class="px-6 py-3 text-right">Ganancia</th>
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
                  <td class="px-6 py-4 align-top">
                    <div
                      v-if="linkedEditorItemId === item.id"
                      class="w-[320px] max-w-full space-y-2"
                    >
                      <input
                        v-model="linkedEditorQuery"
                        type="text"
                        class="ui-input !py-2.5"
                        placeholder="Busca un producto para vincular..."
                        @input="searchLinkedProducts"
                        @keyup.esc="closeLinkedProductEditor"
                      />
                      <p class="text-[11px] text-slate-400">
                        Este cambio reemplaza el producto vinculado actual para
                        este útil.
                      </p>

                      <div
                        v-if="linkedEditorLoading"
                        class="rounded-xl border border-slate-200 bg-white px-3 py-4 text-center text-xs font-medium text-slate-500"
                      >
                        Buscando productos...
                      </div>
                      <div
                        v-else-if="linkedEditorResults.length"
                        class="max-h-64 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-sm"
                      >
                        <button
                          v-for="product in linkedEditorResults"
                          :key="product.id"
                          type="button"
                          class="flex w-full items-start justify-between gap-3 border-b border-slate-100 px-3 py-2.5 text-left transition last:border-b-0 hover:bg-indigo-50"
                          :disabled="linkedEditorSavingItemId === item.id"
                          @click="replaceLinkedProduct(item, product)"
                        >
                          <div class="min-w-0">
                            <p class="truncate text-sm font-semibold text-slate-800">
                              {{ product.name }}
                            </p>
                            <p class="text-xs text-slate-500">
                              {{ product.brand || "Genérico" }}
                              <span v-if="product.sku">· {{ product.sku }}</span>
                            </p>
                          </div>
                          <div class="shrink-0 text-right">
                            <p class="text-xs font-bold text-indigo-600">
                              {{ formatMoney(product.sale_price) }}
                            </p>
                            <p class="text-[11px] text-slate-400">
                              Stock: {{ product.stock_on_hand }}
                            </p>
                          </div>
                        </button>
                      </div>
                      <p
                        v-else-if="linkedEditorQuery.trim().length >= 2"
                        class="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-3 py-3 text-xs text-slate-500"
                      >
                        No encontré productos con esa búsqueda.
                      </p>

                      <div class="flex items-center gap-2">
                        <button
                          class="ui-btn-secondary px-3 py-2 text-xs"
                          :disabled="linkedEditorSavingItemId === item.id"
                          @click="closeLinkedProductEditor"
                        >
                          Cancelar
                        </button>
                        <span
                          v-if="linkedEditorSavingItemId === item.id"
                          class="text-xs font-medium text-indigo-600"
                        >
                          Guardando vínculo...
                        </span>
                        <button
                          type="button"
                          class="text-xs font-semibold text-rose-600 hover:text-rose-700"
                          :disabled="linkedEditorSavingItemId === item.id"
                          @click="removeListItem(item)"
                        >
                          Eliminar fila
                        </button>
                      </div>
                    </div>

                    <div v-else class="space-y-2">
                      <div v-if="getLinkedProduct(item)">
                        <p
                          class="font-semibold text-indigo-600 truncate max-w-[220px]"
                          :title="getLinkedProduct(item).name"
                        >
                          {{ getLinkedProduct(item).name }}
                        </p>
                        <p class="text-xs text-slate-500">
                          {{ getLinkedProduct(item).brand || "Genérico" }}
                        </p>
                      </div>
                      <span v-else class="text-xs text-amber-500 font-bold">
                        ⚠️ No vinculado
                      </span>
                      <button
                        type="button"
                        class="text-xs font-semibold text-indigo-600 hover:text-indigo-700"
                        @click="openLinkedProductEditor(item)"
                      >
                        {{
                          getLinkedProduct(item)
                            ? "Editar / cambiar"
                            : "Buscar y vincular"
                        }}
                      </button>
                      <button
                        type="button"
                        class="block text-xs font-semibold text-rose-600 hover:text-rose-700"
                        :disabled="linkedEditorSavingItemId === item.id"
                        @click="removeListItem(item)"
                      >
                        Eliminar fila
                      </button>
                    </div>
                  </td>
                  <td class="px-6 py-4 align-top">
                    <div v-if="getLinkedProduct(item)" class="space-y-2">
                      <select
                        class="ui-select min-w-[220px] text-xs"
                        :value="getSelectedPresentationKey(item)"
                        :disabled="
                          presentationOptionsLoadingProductId ===
                            getLinkedProduct(item).product_id
                        "
                        @focus="ensurePresentationOptions(item)"
                        @change="onPresentationSelectChange(item, $event)"
                      >
                        <option
                          v-for="option in getCompatiblePresentationOptions(item)"
                          :key="option.key"
                          :value="option.key"
                          :disabled="!isPresentationOptionSelectable(item, option)"
                        >
                          {{
                            option.label +
                            " · " +
                            formatMoney(option.price_uom) +
                            (getPresentationOptionDisabledReason(item, option)
                              ? ` · ${getPresentationOptionDisabledReason(item, option)}`
                              : "")
                          }}
                        </option>
                      </select>
                      <p class="max-w-[220px] text-[11px] leading-5 text-slate-400">
                        {{ getSelectedPresentationHelper(item) }}
                        <span v-if="presentationOptionsLoadingProductId === getLinkedProduct(item).product_id">
                          · cargando opciones...
                        </span>
                        <span v-else-if="presentationPriceSavingBrandId === getLinkedProduct(item).brand_id">
                          · guardando...
                        </span>
                      </p>
                      <NuxtLink
                        class="inline-flex w-fit items-center text-[11px] font-semibold text-indigo-600 hover:text-indigo-700"
                        :to="pricingConfigRoute(getLinkedProduct(item).id)"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Editar presentaciones
                      </NuxtLink>
                    </div>
                    <span v-else class="text-xs text-slate-400">
                      Vincula un producto primero
                    </span>
                  </td>
                  <td class="px-6 py-4">
                    <span
                      v-if="!getLinkedProduct(item)"
                      class="inline-flex rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-bold text-slate-500"
                      >Pendiente</span
                    >
                    <span
                      v-else-if="getActiveVariant(item).match_status === 'ok'"
                      class="inline-flex rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-bold text-emerald-700"
                      >✓
                      {{ getLinkedProduct(item).stock_on_hand }}
                      en stock</span
                    >
                    <span
                      v-else-if="getActiveVariant(item).match_status === 'low'"
                      class="inline-flex rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-bold text-amber-700"
                      >Stock bajo ({{ getLinkedProduct(item).stock_on_hand }})</span
                    >
                    <span
                      v-else
                      class="inline-flex rounded-full bg-rose-100 px-2.5 py-0.5 text-xs font-bold text-rose-700"
                      >Sin stock (0)</span
                    >
                  </td>
                  <td class="px-6 py-4 text-right font-medium text-slate-600">
                    <div v-if="getLinkedProduct(item)">
                      <p>S/ {{ getLinkedProduct(item).sale_price.toFixed(2) }}</p>
                      <p class="text-[11px] text-slate-400">
                        {{ getLinkedProduct(item).unit }}
                      </p>
                    </div>
                    <span v-else>-</span>
                  </td>
                  <td
                    class="px-6 py-4 text-right font-bold"
                    :class="
                      getLinkedProduct(item)
                        ? profitTextClass(getProfitTotal(item))
                        : 'text-slate-400'
                    "
                  >
                    {{
                      getLinkedProduct(item)
                        ? formatMoney(getProfitTotal(item))
                        : "-"
                    }}
                  </td>
                  <td class="px-6 py-4 text-right font-bold text-slate-800">
                    {{
                      getLinkedProduct(item)
                        ? "S/ " + getActiveVariant(item).subtotal.toFixed(2)
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
