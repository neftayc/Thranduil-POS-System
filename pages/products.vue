<script setup lang="ts">
import * as XLSX from "xlsx";
import { matchesTokensAndFuzzy } from "~/utils/productSearch";

const products = ref<any[]>([]);
const unitCatalog = ref<Array<{ code: string; label: string }>>([]);
const categoryCatalog = ref<Array<{ id: string; code: string; name: string }>>(
  [],
);
const search = ref("");
const loading = ref(false);
const inlinePriceSavingId = ref("");
const inlinePriceOriginal = ref<Record<string, number>>({});
const message = ref("");
const importMessage = ref("");
const showForm = ref(false);
const showImportModal = ref(false);
const productFilters = reactive({
  stockZero: false,
  latestWeek: false,
  missingPresentation: false,
  salePriceZero: false,
  status: "all" as "all" | "active" | "inactive",
  category: "all",
  fifoWithStock: false,
});

const form = reactive({
  id: "",
  sku: "",
  name: "",
  brand: "",
  category_name: "",
  barcode: "",
  unit: "unidad",
  sale_price: 0,
  stock_on_hand: 0,
  avg_cost: 0,
  min_stock: 0,
  active: true,
  unit_conversions: [] as Array<{
    unit_name: string;
    factor_to_base: number;
    is_active: boolean;
  }>,
});

const isEditing = computed(() => Boolean(form.id));

const productSummary = computed(() => {
  const total = products.value.length;
  const active = products.value.filter((item) => item.active !== false).length;
  const low = products.value.filter(
    (item) => Number(item.stock_on_hand || 0) <= Number(item.min_stock || 0),
  ).length;

  return { total, active, low };
});

const unitOptions = computed(() => {
  if (unitCatalog.value.length) return unitCatalog.value;
  return [{ code: "unidad", label: "Unidad" }];
});

const priceAdjust = reactive({
  mode: "percent" as "percent" | "amount",
  value: 0,
  margin_pct: 30,
});

const roundMoney = (value: number) => Number(Math.max(0, value).toFixed(2));

const currentMarginPct = computed(() => {
  const cost = Number(form.avg_cost || 0);
  const sale = Number(form.sale_price || 0);
  if (cost <= 0 || sale <= 0) return null;
  return Number((((sale - cost) / cost) * 100).toFixed(2));
});

const applyPriceAdjustment = (direction: "up" | "down") => {
  const current = Number(form.sale_price || 0);
  const value = Number(priceAdjust.value || 0);
  if (!Number.isFinite(value) || value <= 0) {
    message.value = "Ingresa un valor válido para ajustar el precio.";
    return;
  }

  let next = current;
  if (priceAdjust.mode === "percent") {
    const ratio = value / 100;
    next = direction === "up" ? current * (1 + ratio) : current * (1 - ratio);
  } else {
    next = direction === "up" ? current + value : current - value;
  }

  form.sale_price = roundMoney(next);
  message.value = `Precio base actualizado a S/ ${form.sale_price.toFixed(2)}`;
};

const setPriceFromMargin = () => {
  const cost = Number(form.avg_cost || 0);
  const margin = Number(priceAdjust.margin_pct || 0);

  if (!Number.isFinite(cost) || cost <= 0) {
    message.value = "Define primero un costo promedio mayor a 0.";
    return;
  }

  if (!Number.isFinite(margin) || margin < 0) {
    message.value = "El margen debe ser 0 o mayor.";
    return;
  }

  form.sale_price = roundMoney(cost * (1 + margin / 100));
  message.value = `Precio base calculado por margen: S/ ${form.sale_price.toFixed(2)}`;
};

const normalizeSalePrice = (value: any) => roundMoney(Number(value || 0));

const resetForm = () => {
  form.id = "";
  form.sku = "";
  form.name = "";
  form.brand = "";
  form.category_name = "";
  form.barcode = "";
  form.unit = "unidad";
  form.sale_price = 0;
  form.stock_on_hand = 0;
  form.avg_cost = 0;
  form.min_stock = 0;
  form.active = true;
  form.unit_conversions = [];
  priceAdjust.mode = "percent";
  priceAdjust.value = 0;
  priceAdjust.margin_pct = 30;
};

const openCreateForm = () => {
  resetForm();
  showForm.value = true;
};

const closeForm = () => {
  resetForm();
  showForm.value = false;
};

const openImportModal = () => {
  importMessage.value = "";
  showImportModal.value = true;
};

const closeImportModal = () => {
  showImportModal.value = false;
};

const loadProducts = async () => {
  loading.value = true;
  message.value = "";
  try {
    const data = await $fetch<{ units: any[]; categories: any[]; products: any[] }>(
      "/api/products/page",
    );

    unitCatalog.value = (data.units || []).length
      ? (data.units as any[])
      : [{ code: "unidad", label: "Unidad" }];
    categoryCatalog.value = (data.categories || []) as any[];
    products.value = (data.products || []).map((item) => ({
      ...item,
      sale_price: normalizeSalePrice(item.sale_price),
    }));
    inlinePriceOriginal.value = Object.fromEntries(
      products.value.map((item) => [
        item.id,
        normalizeSalePrice(item.sale_price),
      ]),
    );
  } catch (err: any) {
    message.value =
      err?.data?.statusMessage ||
      err?.message ||
      "No se pudieron cargar productos.";
  } finally {
    loading.value = false;
  }
};

const upsertCatalogProduct = async (payload: any) => {
  const res = await $fetch<{ id: string }>("/api/products/catalog-upsert", {
    method: "POST",
    body: {
      p_id: payload.id || null,
      p_sku: payload.sku || null,
      p_name: payload.name,
      p_unit: payload.unit || "unidad",
      p_brand: payload.brand || null,
      p_category_name: payload.category_name || null,
      p_barcode: payload.barcode || null,
      p_active: payload.active !== false,
      p_sale_price: Number(payload.sale_price || 0),
      p_min_stock: Number(payload.min_stock || 0),
      p_stock_on_hand:
        payload.stock_on_hand === null || payload.stock_on_hand === undefined
          ? null
          : Number(payload.stock_on_hand || 0),
      p_avg_cost:
        payload.avg_cost === null || payload.avg_cost === undefined
          ? null
          : Number(payload.avg_cost || 0),
      p_currency: "PEN",
    },
  });

  return String(res.id);
};

const normalizeText = (value: any) => String(value || "").trim();
const normalizeUnitCode = (value: any) =>
  String(value || "")
    .trim()
    .toLowerCase();

const sanitizeConversions = (baseUnit: string) => {
  const base = normalizeUnitCode(baseUnit);
  const unique = new Set<string>();

  return (form.unit_conversions || [])
    .map((row) => ({
      unit_name: normalizeUnitCode(row.unit_name),
      factor_to_base: Number(row.factor_to_base || 0),
      is_active: row.is_active !== false,
    }))
    .filter((row) => {
      if (!row.unit_name || row.unit_name === base) return false;
      if (!Number.isFinite(row.factor_to_base) || row.factor_to_base <= 0)
        return false;
      if (unique.has(row.unit_name)) return false;
      unique.add(row.unit_name);
      return true;
    });
};

const resolveUnitCode = (raw: any) => {
  const value = normalizeUnitCode(raw);
  if (!value) return "unidad";

  const match = unitOptions.value.find((item) => {
    const label = normalizeUnitCode(item.label);
    return (
      item.code === value ||
      label === value ||
      `${item.code}s` === value ||
      `${label}s` === value
    );
  });

  return match?.code || "unidad";
};

const unitLabel = (code: string) => {
  const normalized = normalizeUnitCode(code);
  const found = unitOptions.value.find((item) => item.code === normalized);
  return found?.label || normalized || "Unidad";
};

const normalizeSkuKey = (value: any) =>
  String(value || "")
    .trim()
    .toUpperCase();

const skuExists = (sku: string, excludeId = "") => {
  const key = normalizeSkuKey(sku);
  if (!key) return false;
  return products.value.some((product) => {
    const productId = String(product?.id || "");
    if (excludeId && productId === excludeId) return false;
    return normalizeSkuKey(product?.sku) === key;
  });
};

const generateRegisterSku = (name: string) => {
  const base = String(name || "")
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9]+/g, "")
    .slice(0, 8) || "ITEM";

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const rawTail =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID().split("-")[0]
        : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const tail = rawTail
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 8);
    const candidate = `SKU-${base}-${tail || String(Date.now()).slice(-6)}`;
    if (!skuExists(candidate)) return candidate;
  }

  return `SKU-${base}-${Date.now().toString(36).toUpperCase()}`;
};

const resetFilters = () => {
  productFilters.stockZero = false;
  productFilters.latestWeek = false;
  productFilters.missingPresentation = false;
  productFilters.salePriceZero = false;
  productFilters.status = "all";
  productFilters.category = "all";
  productFilters.fifoWithStock = false;
};

const hasMissingPresentation = (product: any) => {
  const missing = Array.isArray(product?.missing_purchase_units)
    ? product.missing_purchase_units
    : [];
  if (missing.length > 0) return true;
  return product?.needs_presentation_setup === true;
};

const isLatestWeekProduct = (product: any) => {
  const createdAt = product?.created_at ? new Date(product.created_at) : null;
  if (!createdAt || Number.isNaN(createdAt.getTime())) return false;
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  return createdAt >= weekAgo;
};

const missingUnitsLabel = (raw: any) => {
  const units = Array.isArray(raw) ? raw : [];
  const labels = units
    .map((unit) => unitLabel(String(unit || "")))
    .filter((label) => Boolean(label));
  return labels.join(", ");
};

const productCategoryLabel = (product: any) => {
  const label = String(product?.category_name || product?.product_type || "").trim();
  return label || "Sin categoría";
};

const normalizeCategoryFilterKey = (value: any) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

const categoryFilterOptions = computed(() => {
  const categories = new Map<string, { label: string; count: number }>();

  for (const category of categoryCatalog.value) {
    const label = String(category?.name || "").trim();
    if (!label) continue;
    const key = normalizeCategoryFilterKey(label);
    if (!key) continue;
    if (!categories.has(key)) categories.set(key, { label, count: 0 });
  }

  for (const product of products.value) {
    const label = productCategoryLabel(product);
    const key = normalizeCategoryFilterKey(label);
    if (!key) continue;
    const current = categories.get(key);
    if (current) {
      current.count += 1;
    } else {
      categories.set(key, { label, count: 1 });
    }
  }

  return [...categories.entries()]
    .sort((a, b) =>
      a[1].label.localeCompare(b[1].label, "es", { sensitivity: "base" }),
    )
    .map(([key, item]) => ({
      key,
      label: item.label,
      count: item.count,
    }));
});

const conversionOptions = (currentCode = "") => {
  const current = normalizeUnitCode(currentCode);
  const base = normalizeUnitCode(form.unit);
  const used = new Set(
    form.unit_conversions
      .map((row) => normalizeUnitCode(row.unit_name))
      .filter((code) => code && code !== current),
  );

  return unitOptions.value.filter(
    (item) =>
      item.code !== base && (!used.has(item.code) || item.code === current),
  );
};

const syncProductConversions = async (productId: string, baseUnit: string) => {
  const payload = sanitizeConversions(baseUnit);
  await $fetch("/api/products/conversions-replace", {
    method: "POST",
    body: {
      p_product_id: productId,
      p_items: payload,
    },
  });
};

const saveProduct = async () => {
  loading.value = true;
  message.value = "";
  try {
    let generatedSku = "";
    const typedSku = cleanSku(form.sku);
    if (!isEditing.value && !typedSku) {
      generatedSku = generateRegisterSku(form.name);
      form.sku = generatedSku;
    } else {
      form.sku = typedSku;
    }

    const baseUnit = resolveUnitCode(form.unit || "unidad");
    form.unit = baseUnit;
    const productId = await upsertCatalogProduct({
      ...form,
      sku: cleanSku(form.sku),
    });
    await syncProductConversions(productId, baseUnit);
    await loadProducts();
    resetForm();
    showForm.value = false;
    message.value = generatedSku
      ? `Producto guardado correctamente. Código generado: ${generatedSku}`
      : "Producto guardado correctamente.";
  } catch (err: any) {
    message.value = err?.message || "No se pudo guardar el producto.";
  } finally {
    loading.value = false;
  }
};

const saveInlineBasePrice = async (product: any) => {
  if (!product?.id) return;

  const productId = String(product.id);
  if (inlinePriceSavingId.value === productId) return;
  const nextPrice = normalizeSalePrice(product.sale_price);
  const previousPrice = normalizeSalePrice(
    inlinePriceOriginal.value[productId] ?? product.sale_price,
  );
  product.sale_price = nextPrice;

  if (nextPrice === previousPrice) return;

  inlinePriceSavingId.value = productId;
  message.value = "";
  try {
    await upsertCatalogProduct({
      ...product,
      sale_price: nextPrice,
    });
    inlinePriceOriginal.value[productId] = nextPrice;
    message.value = `Precio base actualizado: ${product.name} (S/ ${nextPrice.toFixed(2)})`;
  } catch (err: any) {
    product.sale_price = previousPrice;
    message.value = err?.message || "No se pudo actualizar el precio base.";
  } finally {
    inlinePriceSavingId.value = "";
  }
};

const loadProductConversions = async (productId: string, baseUnit: string) => {
  const res = await $fetch<{ items: any[] }>(
    `/api/products/${productId}/conversions`,
  );

  const baseCode = normalizeUnitCode(baseUnit);
  form.unit_conversions = (res.items || [])
    .map((row) => ({
      unit_name: normalizeUnitCode(row.unit_name),
      factor_to_base: Number(row.factor_to_base || 0),
      is_active: row.is_active !== false,
    }))
    .filter((row) => row.unit_name !== baseCode);
};

const addConversionRow = () => {
  form.unit_conversions.push({
    unit_name: "",
    factor_to_base: 1,
    is_active: true,
  });
};

const removeConversionRow = (index: number) => {
  form.unit_conversions.splice(index, 1);
};

const editProduct = async (product: any) => {
  form.id = product.id;
  form.sku = product.sku || "";
  form.name = product.name || "";
  form.brand = product.brand || "";
  form.category_name = product.category_name || product.product_type || "";
  form.barcode = product.barcode || "";
  form.unit = resolveUnitCode(product.unit || "unidad");
  form.sale_price = Number(product.sale_price || 0);
  form.stock_on_hand = Number(product.stock_on_hand || 0);
  form.avg_cost = Number(product.avg_cost || 0);
  form.min_stock = Number(product.min_stock || 0);
  form.active = product.active !== false;
  form.unit_conversions = [];
  try {
    await loadProductConversions(product.id, form.unit || "unidad");
  } catch (err: any) {
    message.value =
      err?.data?.statusMessage ||
      err?.message ||
      "No se pudieron cargar las presentaciones.";
  }
  showForm.value = true;
};

const formatStockQty = (value: any) => {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return "0";
  return String(Math.round(numeric));
};

const hasFifoPending = (product: any) => {
  if (product?.fifo_has_pending === true) return true;
  if (product?.fifo_has_pending === false) return false;
  const fifoQty = Number(product?.fifo_next_qty || 0);
  const stock = Number(product?.stock_on_hand || 0);
  if (!Number.isFinite(fifoQty) || !Number.isFinite(stock)) return false;
  if (fifoQty <= 0 || stock <= 0) return false;
  return fifoQty < stock - 0.0005;
};

const fifoCostDisplay = (product: any) => {
  if (!hasFifoPending(product)) {
    const lastCost = Number(product?.last_purchase_cost || 0);
    if (lastCost > 0) return lastCost.toFixed(2);
  }

  const nextCost = Number(product?.fifo_next_cost || 0);
  if (nextCost > 0) return nextCost.toFixed(2);

  const stockQty = Number(product?.fifo_stock_qty || 0);
  if (stockQty > 0) {
    const stockValue = Number(product?.fifo_stock_value || 0);
    return (stockValue / stockQty).toFixed(2);
  }

  return "0.00";
};

const fifoStockHint = (product: any) => {
  if (hasFifoPending(product)) {
    return `FIFO: ${formatStockQty(product?.fifo_next_qty)} und`;
  }
  return "";
};

const filteredProducts = computed(() => {
  const term = search.value;

  return products.value.filter((p) => {
    const categoryLabel = productCategoryLabel(p);
    const searchable =
      `${p.name || ""} ${p.sku || ""} ${p.brand || ""} ${categoryLabel}`;
    if (!matchesTokensAndFuzzy(term, searchable)) return false;

    if (productFilters.stockZero && Number(p.stock_on_hand || 0) !== 0)
      return false;
    if (productFilters.latestWeek && !isLatestWeekProduct(p)) return false;
    if (productFilters.missingPresentation && !hasMissingPresentation(p))
      return false;
    if (productFilters.salePriceZero && Number(p.sale_price || 0) !== 0)
      return false;
    if (productFilters.fifoWithStock && !hasFifoPending(p))
      return false;

    if (productFilters.status === "active" && p.active === false) return false;
    if (productFilters.status === "inactive" && p.active !== false)
      return false;
    if (productFilters.category !== "all") {
      const key = normalizeCategoryFilterKey(categoryLabel);
      if (key !== productFilters.category) return false;
    }

    return true;
  });
});

const normalizeKey = (value: string) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

const normalizeRowKeys = (row: Record<string, any>) => {
  const mapped: Record<string, any> = {};
  Object.entries(row || {}).forEach(([key, value]) => {
    mapped[normalizeKey(key)] = value;
  });
  return mapped;
};

const pickField = (row: Record<string, any>, aliases: string[]) => {
  for (const alias of aliases) {
    const key = normalizeKey(alias);
    if (Object.prototype.hasOwnProperty.call(row, key)) {
      const value = row[key];
      if (
        value !== null &&
        value !== undefined &&
        String(value).trim() !== ""
      ) {
        return value;
      }
    }
  }

  return "";
};

const parseNumeric = (input: any) => {
  if (typeof input === "number") return Number.isFinite(input) ? input : 0;
  const raw = String(input || "").trim();
  if (!raw) return 0;

  const compact = raw.replace(/\s+/g, "");
  if (/^-?\d{1,3}(\.\d{3})*(,\d+)?$/.test(compact)) {
    return Number(compact.replace(/\./g, "").replace(",", ".")) || 0;
  }
  if (/^-?\d{1,3}(,\d{3})*(\.\d+)?$/.test(compact)) {
    return Number(compact.replace(/,/g, "")) || 0;
  }
  return Number(compact.replace(",", ".")) || 0;
};

const scoreSheet = (rows: any[]) => {
  if (!rows.length) return -1;
  const keys = Object.keys(rows[0]).map(normalizeKey);

  let score = 0;
  if (
    keys.some((k) => ["nombre_del_elemento", "nombre", "producto"].includes(k))
  )
    score += 60;
  if (keys.some((k) => ["id_de_articulo", "codigo", "sku"].includes(k)))
    score += 20;
  if (keys.some((k) => ["count", "stock", "cantidad", "stok"].includes(k)))
    score += 10;
  if (
    keys.some((k) =>
      ["precio_de_venta_sugerido", "precio_venta", "precio"].includes(k),
    )
  )
    score += 10;

  return score;
};

const selectBestSheetRows = (workbook: XLSX.WorkBook) => {
  let bestRows: any[] = [];
  let bestSheetName = "";
  let bestScore = -1;

  workbook.SheetNames.forEach((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) return;
    const rows: any[] = XLSX.utils.sheet_to_json(sheet, { defval: "" });
    const score = scoreSheet(rows);
    if (score > bestScore) {
      bestRows = rows;
      bestSheetName = sheetName;
      bestScore = score;
    }
  });

  return { rows: bestRows, sheetName: bestSheetName, score: bestScore };
};

const cleanSku = (value: string) => {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  if (normalizeKey(normalized) === "nuevo") return "";
  return normalized;
};

const makeAutoSku = (name: string, index: number) => {
  const base = String(name || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "")
    .slice(0, 8);
  return `AUTO-${base || "ITEM"}-${String(index + 1).padStart(4, "0")}`;
};

const importFromExcel = async (event: Event) => {
  importMessage.value = "";
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  loading.value = true;
  try {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array" });
    const selected = selectBestSheetRows(workbook);
    const rows = selected.rows;

    if (!rows.length || selected.score < 0) {
      importMessage.value = "No se encontró una hoja válida para importar.";
      return;
    }

    const normalized = rows
      .map((row, index) => {
        const mapped = normalizeRowKeys(row);
        const rawSku = String(
          pickField(mapped, [
            "id de articulo",
            "codigo",
            "sku",
            "id articulo",
          ]) || "",
        );
        const sku =
          cleanSku(rawSku) ||
          makeAutoSku(
            String(
              pickField(mapped, [
                "nombre del elemento",
                "nombre",
                "producto",
              ]) || "",
            ),
            index,
          );

        const name = String(
          pickField(mapped, ["nombre del elemento", "nombre", "producto"]) ||
            "",
        ).trim();

        const salePrice = pickField(mapped, [
          "precio de venta sugerido",
          "precio_venta",
          "precio de venta",
          "precio",
        ]);
        const avgCost = pickField(mapped, [
          "precio por unidad",
          "costo unitario",
          "costo",
          "costo promedio",
        ]);
        const stock = pickField(mapped, [
          "stock",
          "stok",
          "#",
          "cantidad",
          "count",
        ]);
        const minStock = pickField(mapped, [
          "min_stock",
          "stock minimo",
          "minimo",
        ]);
        const rawUnit = String(
          pickField(mapped, ["unidad de venta", "unidad medida", "unidad"]) ||
            "unidad",
        ).trim();
        const brand = String(
          pickField(mapped, ["marca", "brand"]) || "",
        ).trim();
        const categoryName = String(
          pickField(mapped, ["tipo", "categoria", "product_type", "category_name"]) || "",
        ).trim();
        const barcode = String(
          pickField(mapped, ["barcode", "codigo barras", "codigo_de_barras"]) ||
            "",
        ).trim();

        return {
          sku,
          name,
          unit: resolveUnitCode(rawUnit || "unidad"),
          brand,
          category_name: categoryName,
          barcode,
          sale_price: parseNumeric(salePrice),
          stock_on_hand: parseNumeric(stock),
          avg_cost: parseNumeric(avgCost),
          min_stock: parseNumeric(minStock),
          active: true,
        };
      })
      .filter((row) => row.name);

    if (!normalized.length) {
      importMessage.value = "No se encontraron filas válidas.";
      return;
    }

    const batchSize = 30;
    for (let i = 0; i < normalized.length; i += batchSize) {
      const batch = normalized.slice(i, i + batchSize);
      await Promise.all(batch.map((row) => upsertCatalogProduct(row)));
    }

    importMessage.value = `Importados ${normalized.length} productos desde "${selected.sheetName}".`;
    await loadProducts();
  } catch (err: any) {
    importMessage.value = err?.message || "Error al importar.";
  } finally {
    loading.value = false;
    input.value = "";
  }
};

onMounted(loadProducts);
</script>

<template>
  <div class="space-y-6">
    <section
      class="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden"
    >
      <!-- Header -->
      <div
        class="p-6 border-b border-slate-100 flex flex-col lg:flex-row justify-between lg:items-center gap-4"
      >
        <div>
          <h2 class="text-xl font-black text-slate-800 tracking-tight">
            Listado de productos
          </h2>
          <div class="mt-2 flex flex-wrap gap-2">
            <span
              class="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-600"
            >
              Total: {{ productSummary.total }}
            </span>
            <span
              class="inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-700"
            >
              Activos: {{ productSummary.active }}
            </span>
            <span
              class="inline-flex items-center rounded-full bg-rose-100 px-2.5 py-0.5 text-xs font-semibold text-rose-700"
            >
              Stock bajo: {{ productSummary.low }}
            </span>
          </div>
        </div>

        <div class="flex items-center gap-3 w-full lg:w-auto">
          <button
            class="ui-btn-secondary flex-1 lg:flex-none justify-center"
            @click="openImportModal"
          >
            <svg
              class="w-4 h-4 mr-1.5 inline-block text-slate-500"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
              />
            </svg>
            Importar
          </button>
          <button
            class="ui-btn flex-1 lg:flex-none justify-center bg-indigo-600 hover:bg-indigo-700 text-white"
            @click="openCreateForm"
          >
            <svg
              class="w-4 h-4 mr-1.5 inline-block"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M12 4v16m8-8H4"
              />
            </svg>
            Añadir producto
          </button>
        </div>
      </div>

      <!-- Filters Section -->
      <div class="bg-slate-50 p-4 space-y-4">
        <!-- Search and Status row -->
        <div class="flex flex-col sm:flex-row gap-3">
          <div class="relative flex-1">
            <div
              class="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none"
            >
              <svg
                class="h-5 w-5 text-slate-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
            </div>
            <input
              v-model="search"
              type="text"
              class="ui-input w-full pl-10"
              placeholder="Buscar por nombre, SKU, marca o categoría..."
            />
          </div>
          <div class="w-full sm:w-48 shrink-0">
            <select v-model="productFilters.status" class="ui-select w-full">
              <option value="all">Status: Todos</option>
              <option value="active">Solo Activos</option>
              <option value="inactive">Solo Inactivos</option>
            </select>
          </div>
          <div class="w-full sm:w-56 shrink-0">
            <select v-model="productFilters.category" class="ui-select w-full">
              <option value="all">Categoría: Todas</option>
              <option
                v-for="option in categoryFilterOptions"
                :key="`filter-category-${option.key}`"
                :value="option.key"
              >
                {{ option.label }} ({{ option.count }})
              </option>
            </select>
          </div>
        </div>

        <!-- Filter Chips -->
        <div class="flex flex-wrap items-center gap-2">
          <span
            class="text-xs font-semibold text-slate-400 uppercase tracking-wider mr-1"
            >Filtros:</span
          >

          <button
            @click="productFilters.stockZero = !productFilters.stockZero"
            class="inline-flex items-center px-3 py-1.5 rounded-full text-xs font-medium border transition-colors cursor-pointer"
            :class="
              productFilters.stockZero
                ? 'bg-indigo-50 border-indigo-200 text-indigo-700 shadow-sm'
                : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
            "
          >
            <span v-if="productFilters.stockZero" class="mr-1 text-indigo-500"
              >✓</span
            >
            Stock 0
          </button>

          <button
            @click="productFilters.latestWeek = !productFilters.latestWeek"
            class="inline-flex items-center px-3 py-1.5 rounded-full text-xs font-medium border transition-colors cursor-pointer"
            :class="
              productFilters.latestWeek
                ? 'bg-indigo-50 border-indigo-200 text-indigo-700 shadow-sm'
                : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
            "
          >
            <span v-if="productFilters.latestWeek" class="mr-1 text-indigo-500"
              >✓</span
            >
            Últimos 7 días
          </button>

          <button
            @click="
              productFilters.missingPresentation =
                !productFilters.missingPresentation
            "
            class="inline-flex items-center px-3 py-1.5 rounded-full text-xs font-medium border transition-colors cursor-pointer"
            :class="
              productFilters.missingPresentation
                ? 'bg-indigo-50 border-indigo-200 text-indigo-700 shadow-sm'
                : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
            "
          >
            <span
              v-if="productFilters.missingPresentation"
              class="mr-1 text-indigo-500"
              >✓</span
            >
            Falta empaque
          </button>

          <button
            @click="
              productFilters.salePriceZero = !productFilters.salePriceZero
            "
            class="inline-flex items-center px-3 py-1.5 rounded-full text-xs font-medium border transition-colors cursor-pointer"
            :class="
              productFilters.salePriceZero
                ? 'bg-rose-50 border-rose-200 text-rose-700 shadow-sm'
                : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
            "
          >
            <span v-if="productFilters.salePriceZero" class="mr-1 text-rose-500"
              >✓</span
            >
            Precio venta 0
          </button>

          <button
            @click="
              productFilters.fifoWithStock = !productFilters.fifoWithStock
            "
            class="inline-flex items-center px-3 py-1.5 rounded-full text-xs font-medium border transition-colors cursor-pointer"
            :class="
              productFilters.fifoWithStock
                ? 'bg-amber-50 border-amber-200 text-amber-700 shadow-sm'
                : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
            "
          >
            <span
              v-if="productFilters.fifoWithStock"
              class="mr-1 text-amber-500"
              >✓</span
            >
            FIFO pendiente
          </button>

          <div class="flex-1"></div>

          <button
            v-if="
              productFilters.stockZero ||
              productFilters.latestWeek ||
              productFilters.missingPresentation ||
              productFilters.salePriceZero ||
              productFilters.fifoWithStock ||
              productFilters.status !== 'all' ||
              productFilters.category !== 'all'
            "
            @click="resetFilters"
            class="inline-flex items-center px-2 py-1.5 text-xs font-bold text-slate-400 hover:text-slate-600 transition-colors"
          >
            Limpiar filtros
            <svg
              class="w-3.5 h-3.5 ml-1"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
      </div>

      <div
        class="px-6 py-3 flex justify-between items-center bg-white border-b border-slate-100"
      >
        <span class="text-sm font-semibold text-slate-500"
          >Mostrando {{ filteredProducts.length }} resultados</span
        >
      </div>

      <div
        v-if="message"
        class="m-6"
        :class="
          message.toLowerCase().includes('no se pudo') ||
          message.toLowerCase().includes('error')
            ? 'ui-alert-error'
            : 'ui-alert'
        "
      >
        {{ message }}
      </div>

      <div class="ui-table-wrap mt-5">
        <table class="ui-table">
          <thead>
            <tr>
              <th>Código</th>
              <th>Producto</th>
              <th>Marca</th>
              <th>Unidad base</th>
              <th>Costo prom. (Compra)</th>
              <th>Último costo</th>
              <th>Costo real FIFO</th>
              <th>Precio base venta</th>
              <th>Stock actual</th>
              <th>Estado</th>
              <th>Acción</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="product in filteredProducts" :key="product.id">
              <td>{{ product.sku || "-" }}</td>
              <td>
                <p class="font-semibold text-slate-800">{{ product.name }}</p>
                <p class="text-xs text-slate-400">
                  {{ productCategoryLabel(product) }}
                </p>
                <p
                  v-if="product.needs_presentation_setup"
                  class="mt-1 text-xs font-semibold text-amber-600"
                >
                  Falta presentación:
                  {{
                    missingUnitsLabel(product.missing_purchase_units) ||
                    "Revisar unidades de compra"
                  }}
                </p>
              </td>
              <td>{{ product.brand || "-" }}</td>
              <td>{{ unitLabel(product.unit || "unidad") }}</td>
              <td>
                <span class="font-medium text-slate-700"
                  >S/ {{ Number(product.avg_cost || 0).toFixed(2) }}</span
                >
              </td>
              <td>
                <span class="font-medium text-slate-700"
                  >S/
                  {{ Number(product.last_purchase_cost || 0).toFixed(2) }}</span
                >
              </td>
              <td>
                <p class="font-medium text-slate-700">
                  S/ {{ fifoCostDisplay(product) }}
                </p>
                <p
                  v-if="fifoStockHint(product)"
                  class="text-[11px] text-slate-500"
                >
                  {{ fifoStockHint(product) }}
                </p>
              </td>
              <td>
                <div class="flex items-center gap-2">
                  <input
                    v-model.number="product.sale_price"
                    class="ui-input h-9 w-28 px-2 py-1.5 text-sm"
                    type="number"
                    min="0"
                    step="0.01"
                    :disabled="inlinePriceSavingId === product.id"
                    @blur="saveInlineBasePrice(product)"
                    @keydown.enter.prevent="saveInlineBasePrice(product)"
                  />
                </div>
                <p
                  v-if="inlinePriceSavingId === product.id"
                  class="mt-1 text-[11px] text-slate-500"
                >
                  Guardando...
                </p>
                <p
                  v-else-if="Number(product.avg_cost || 0) > 0"
                  class="mt-1 text-[11px] text-slate-500"
                >
                  Margen:
                  <span
                    :class="
                      ((Number(product.sale_price || 0) -
                        Number(product.avg_cost || 0)) /
                        Number(product.avg_cost || 0)) *
                        100 <
                      0
                        ? 'text-red-500'
                        : 'text-emerald-600'
                    "
                    >{{
                      (
                        ((Number(product.sale_price || 0) -
                          Number(product.avg_cost || 0)) /
                          Number(product.avg_cost || 0)) *
                        100
                      ).toFixed(1)
                    }}%</span
                  >
                </p>
              </td>
              <td>
                <span
                  class="ui-pill"
                  :class="
                    Number(product.stock_on_hand || 0) <=
                    Number(product.min_stock || 0)
                      ? 'ui-pill-low'
                      : ''
                  "
                >
                  {{ formatStockQty(product.stock_on_hand) }}
                </span>
              </td>
              <td>
                <span
                  class="inline-flex rounded-full px-2.5 py-1 text-xs font-semibold"
                  :class="
                    product.active === false
                      ? 'bg-slate-100 text-slate-600'
                      : 'bg-emerald-100 text-emerald-500'
                  "
                >
                  {{ product.active === false ? "Inactivo" : "Activo" }}
                </span>
              </td>
              <td>
                <button
                  class="ui-btn-secondary px-3 py-2"
                  @click="editProduct(product)"
                >
                  Editar
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p
        v-if="!filteredProducts.length && !loading"
        class="ui-empty-state mt-4"
      >
        No hay productos que coincidan con la búsqueda o los filtros.
      </p>
    </section>

    <Teleport to="body">
      <div
        v-if="showForm"
        class="fixed inset-0 z-[1000] flex items-center justify-center p-4"
      >
        <button
          class="absolute inset-0 bg-slate-900/55 backdrop-blur-sm"
          aria-label="Cerrar modal"
          @click="closeForm"
        />

        <section
          class="relative max-h-[92vh] w-full max-w-5xl overflow-y-auto rounded-2xl border border-gray-200 bg-slate-50 p-4 shadow-2xl sm:p-6"
        >
          <div class="grid gap-6">
            <article class="ui-card">
              <div class="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 class="ui-heading">
                    {{ isEditing ? "Editar producto" : "Nuevo producto" }}
                  </h2>
                  <p class="ui-subtitle">
                    Completa catálogo, precio base y datos de inventario.
                  </p>
                </div>
                <button class="ui-btn-secondary" @click="closeForm">
                  Cerrar
                </button>
              </div>

              <div class="mt-5 grid gap-4 sm:grid-cols-2">
                <div>
                  <label class="ui-label">Código</label>
                  <input
                    v-model="form.sku"
                    class="ui-input"
                    type="text"
                    placeholder="Ej: LAP-001 (opcional)"
                  />
                  <p class="mt-1 text-xs text-slate-400">
                    Si lo dejas vacío, se genera automáticamente al guardar.
                  </p>
                </div>
                <div>
                  <label class="ui-label">Nombre</label>
                  <input
                    v-model="form.name"
                    class="ui-input"
                    type="text"
                    placeholder="Ej: Lápiz HB"
                  />
                </div>
                <div>
                  <label class="ui-label">Marca</label>
                  <input
                    v-model="form.brand"
                    class="ui-input"
                    type="text"
                    placeholder="Ej: Artesco"
                  />
                </div>
                <div>
                  <label class="ui-label">Categoría</label>
                  <input
                    v-model="form.category_name"
                    class="ui-input"
                    type="text"
                    list="product-category-options"
                    placeholder="Ej: Útiles"
                  />
                  <datalist id="product-category-options">
                    <option
                      v-for="option in categoryCatalog"
                      :key="option.id"
                      :value="option.name"
                    ></option>
                  </datalist>
                </div>
                <div>
                  <label class="ui-label">Unidad base del producto</label>
                  <select v-model="form.unit" class="ui-select">
                    <option
                      v-for="option in unitOptions"
                      :key="option.code"
                      :value="option.code"
                    >
                      {{ option.label }}
                    </option>
                  </select>
                </div>
                <div>
                  <label class="ui-label">Código de barras</label>
                  <input
                    v-model="form.barcode"
                    class="ui-input"
                    type="text"
                    placeholder="Opcional"
                  />
                </div>
                <div>
                  <label class="ui-label"
                    >Precio base de venta (S/ por unidad base)</label
                  >
                  <input
                    v-model.number="form.sale_price"
                    class="ui-input"
                    type="number"
                    min="0"
                    step="0.01"
                  />
                  <p class="mt-1 text-xs text-slate-400">
                    Este es el precio normal. Precios especiales se configuran
                    en <strong>Reglas de venta</strong>.
                  </p>
                </div>
                <div>
                  <label class="ui-label">Stock actual (inventario)</label>
                  <input
                    v-model.number="form.stock_on_hand"
                    class="ui-input"
                    type="number"
                    min="0"
                    step="1"
                  />
                </div>
                <div>
                  <label class="ui-label">Costo promedio actual (S/)</label>
                  <input
                    v-model.number="form.avg_cost"
                    class="ui-input"
                    type="number"
                    min="0"
                    step="0.0001"
                  />
                </div>
                <div>
                  <label class="ui-label">Stock mínimo</label>
                  <input
                    v-model.number="form.min_stock"
                    class="ui-input"
                    type="number"
                    min="0"
                    step="0.01"
                  />
                </div>
                <div class="sm:col-span-2">
                  <div class="ui-subcard">
                    <div
                      class="flex flex-wrap items-start justify-between gap-3"
                    >
                      <div>
                        <p class="text-sm font-semibold text-slate-800">
                          Ajuste de precio base
                        </p>
                        <p class="text-xs text-slate-400">
                          Precio actual:
                          <span class="font-semibold text-indigo-600"
                            >S/
                            {{ Number(form.sale_price || 0).toFixed(2) }}</span
                          >
                          <span v-if="currentMarginPct !== null" class="ml-2"
                            >Margen estimado: {{ currentMarginPct }}%</span
                          >
                        </p>
                      </div>
                    </div>

                    <div
                      class="mt-4 grid gap-3 sm:grid-cols-[160px_180px_auto_auto]"
                    >
                      <select v-model="priceAdjust.mode" class="ui-select">
                        <option value="percent">Porcentaje (%)</option>
                        <option value="amount">Monto (S/)</option>
                      </select>
                      <input
                        v-model.number="priceAdjust.value"
                        class="ui-input"
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder="Valor de ajuste"
                      />
                      <button
                        type="button"
                        class="ui-btn-secondary px-3 py-2"
                        @click="applyPriceAdjustment('up')"
                      >
                        Subir precio
                      </button>
                      <button
                        type="button"
                        class="ui-btn-secondary px-3 py-2"
                        @click="applyPriceAdjustment('down')"
                      >
                        Bajar precio
                      </button>
                    </div>

                    <div class="mt-3 grid gap-3 sm:grid-cols-[220px_auto]">
                      <input
                        v-model.number="priceAdjust.margin_pct"
                        class="ui-input"
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder="Margen deseado (%)"
                      />
                      <button
                        type="button"
                        class="ui-btn-secondary px-3 py-2"
                        @click="setPriceFromMargin"
                      >
                        Calcular desde costo promedio
                      </button>
                    </div>
                  </div>
                </div>
                <div>
                  <label class="ui-label">Estado</label>
                  <select v-model="form.active" class="ui-select">
                    <option :value="true">Activo</option>
                    <option :value="false">Inactivo</option>
                  </select>
                </div>
                <div class="sm:col-span-2">
                  <div class="ui-subcard">
                    <div
                      class="flex flex-wrap items-center justify-between gap-3"
                    >
                      <div>
                        <p class="text-sm font-semibold text-slate-800">
                          Presentaciones y conversiones
                        </p>
                        <p class="text-xs text-slate-400">
                          Unidad base:
                          <span class="font-semibold text-indigo-600">{{
                            unitLabel(form.unit || "unidad")
                          }}</span>
                        </p>
                      </div>
                      <button
                        type="button"
                        class="ui-btn-secondary px-3 py-2"
                        @click="addConversionRow"
                      >
                        Añadir presentación
                      </button>
                    </div>

                    <div
                      v-if="form.unit_conversions.length"
                      class="mt-4 space-y-3"
                    >
                      <div
                        v-for="(row, index) in form.unit_conversions"
                        :key="index"
                        class="grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:grid-cols-[1fr_180px_auto]"
                      >
                        <div>
                          <label class="ui-label">Unidad comercial</label>
                          <select v-model="row.unit_name" class="ui-select">
                            <option value="">Seleccionar</option>
                            <option
                              v-for="option in conversionOptions(row.unit_name)"
                              :key="option.code"
                              :value="option.code"
                            >
                              {{ option.label }}
                            </option>
                          </select>
                        </div>
                        <div>
                          <label class="ui-label">Factor a base</label>
                          <input
                            v-model.number="row.factor_to_base"
                            class="ui-input"
                            type="number"
                            min="0.0001"
                            step="0.0001"
                          />
                        </div>
                        <div class="flex items-end">
                          <button
                            type="button"
                            class="ui-btn-secondary w-full px-3 py-2"
                            @click="removeConversionRow(index)"
                          >
                            Quitar
                          </button>
                        </div>
                      </div>
                    </div>

                    <p v-else class="mt-4 text-xs text-slate-400">
                      Sin presentaciones adicionales. Ejemplo sugerido:
                      <code>caja = 12</code>.
                    </p>
                  </div>
                </div>
              </div>

              <div class="mt-5 flex flex-wrap gap-3">
                <button class="ui-btn" :disabled="loading" @click="saveProduct">
                  {{
                    loading
                      ? "Guardando..."
                      : isEditing
                        ? "Actualizar producto"
                        : "Guardar producto"
                  }}
                </button>
                <button class="ui-btn-secondary" @click="resetForm">
                  Limpiar formulario
                </button>
              </div>
            </article>
          </div>
        </section>
      </div>
    </Teleport>

    <Teleport to="body">
      <div
        v-if="showImportModal"
        class="fixed inset-0 z-[1000] flex items-center justify-center p-4"
      >
        <button
          class="absolute inset-0 bg-slate-900/55 backdrop-blur-sm"
          aria-label="Cerrar modal de importación"
          @click="closeImportModal"
        />

        <section
          class="relative w-full max-w-2xl rounded-2xl border border-gray-200 bg-white p-6 shadow-2xl sm:p-7"
        >
          <div class="flex items-start justify-between gap-3">
            <div>
              <h2 class="ui-heading">Importar desde Excel</h2>
              <p class="ui-subtitle">
                Soporta columnas como código, nombre, marca, tipo, unidad, costo
                y precio de venta.
              </p>
            </div>
            <button
              class="ui-btn-secondary px-3 py-2"
              @click="closeImportModal"
            >
              Cerrar
            </button>
          </div>

          <div
            class="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4"
          >
            <label class="ui-label">Archivo .xlsx / .xls</label>
            <input
              class="ui-input"
              type="file"
              accept=".xlsx,.xls"
              @change="importFromExcel"
            />
            <p class="mt-2 text-xs text-slate-400">
              El sistema ignora etiquetas "nuevo" en SKU y genera código
              automático cuando falta.
            </p>
          </div>

          <div
            v-if="importMessage"
            class="mt-4"
            :class="
              importMessage.toLowerCase().includes('error') ||
              importMessage.toLowerCase().includes('no se')
                ? 'ui-alert-error'
                : 'ui-alert'
            "
          >
            {{ importMessage }}
          </div>
        </section>
      </div>
    </Teleport>
  </div>
</template>
