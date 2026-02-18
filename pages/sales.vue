<script setup lang="ts">
import { ref, computed, nextTick } from "vue";

type CartItem = {
  product_id: string;
  name: string;
  sku: string | null;
  unit_name: string;
  factor_to_base: number;
  qty: number;
  auto_price_unit: number;
  price_unit: number;
  pricing_source: string;
  pricing_detail: Record<string, any>;
  manual_discount_pct: number;
  manual_discount_amount: number;
  manual_discount_reason: string;
  manual_price_override: number | null;
};

type HeldSale = {
  id: string;
  name: string;
  order_code: string | null;
  source: "db" | "local";
  created_at: string;
  updated_at: string;
  customer_id: string | null;
  payment_method: string;
  items: CartItem[];
};

type SaleSubmitResult = {
  ok: boolean;
  saleId: string | null;
  error: string | null;
};

type SalesTab = "pos" | "checkout" | "history" | "reports";
type ProductFilterKey =
  | "todo"
  | "cuadernos"
  | "papel"
  | "lapices"
  | "arte"
  | "regalos";

const route = useRoute();

const products = ref<any[]>([]);
const productUoms = ref<
  Record<string, Array<{ unit_name: string; factor_to_base: number }>>
>({});
const customers = ref<any[]>([]);
const customerGroups = ref<Array<{ code: string; label: string }>>([]);
const paymentMethods = ref<Array<{ code: string; label: string }>>([]);
const userRole = ref("");
const query = ref("");
const activeProductFilter = ref<ProductFilterKey>("todo");
const cart = ref<CartItem[]>([]);
const customerId = ref<string | null>(null);
const paymentMethod = ref("efectivo");
const activeTab = ref<SalesTab>("pos");
const searchInputRef = ref<HTMLInputElement | null>(null);
const productListRef = ref<HTMLElement | null>(null);
const activeProductIndex = ref(0);
const heldSales = ref<HeldSale[]>([]);
const holdName = ref("");
const selectedHeldSaleId = ref<string | null>(null);
const checkoutPaymentMethod = ref("efectivo");
const checkoutMessage = ref("");
const checkoutLoading = ref(false);
const ordersStorageMode = ref<"db" | "local">("db");
const ordersFallbackWarned = ref(false);
const editingPriceIndex = ref<number | null>(null);
const latestReceipt = ref<{
  saleId: string | null;
  holdName: string;
  paidAt: string;
  paymentMethod: string;
  customerName: string;
  total: number;
  items: CartItem[];
} | null>(null);
const message = ref("");
const loading = ref(false);
const pricingLoading = ref(false);
const pricingResolverUnavailable = ref(false);

// Sales History State
const salesHistory = ref<any[]>([]);
const showDetails = ref(false);
const selectedSale = ref<any>(null);

const totalSalesCount = computed(() => salesHistory.value.length);

const totalItemsSold = computed(() =>
  salesHistory.value.reduce((acc, sale) => {
    // Summing up items count or individual quantities?
    // Usually items count is enough for summary, or sum of quantities if available.
    // Let's sum the number of items (rows) for now as it's safer.
    return acc + (sale.sale_items?.length || 0);
  }, 0),
);

const totalRevenue = computed(() =>
  salesHistory.value.reduce((acc, sale) => acc + toNumber(sale.total, 0), 0),
);

const productFilterOptions: Array<{ key: ProductFilterKey; label: string }> = [
  { key: "todo", label: "Todo" },
  { key: "cuadernos", label: "Cuadernos" },
  { key: "papel", label: "Papel" },
  { key: "lapices", label: "Lapices" },
  { key: "arte", label: "Arte" },
  { key: "regalos", label: "Regalos" },
];

const averageTicket = computed(() =>
  totalSalesCount.value ? totalRevenue.value / totalSalesCount.value : 0,
);

const paymentBreakdown = computed(() => {
  const map: Record<string, { label: string; count: number; total: number }> =
    {};

  for (const sale of salesHistory.value) {
    const code = normalizePaymentCode(sale?.payment_method || "efectivo");
    if (!map[code]) {
      map[code] = { label: paymentLabel(code), count: 0, total: 0 };
    }
    map[code].count += 1;
    map[code].total += toNumber(sale?.total, 0);
  }

  return Object.entries(map)
    .map(([code, value]) => ({ code, ...value }))
    .sort((a, b) => b.total - a.total);
});

const topProductsReport = computed(() => {
  const map: Record<string, { name: string; qty: number; total: number }> = {};

  for (const sale of salesHistory.value) {
    const items = Array.isArray(sale?.sale_items) ? sale.sale_items : [];
    for (const item of items) {
      const name = String(item?.products?.name || "Producto");
      if (!map[name]) {
        map[name] = { name, qty: 0, total: 0 };
      }
      map[name].qty += toNumber(item?.qty_uom ?? item?.qty, 0);
      map[name].total += toNumber(item?.total, 0);
    }
  }

  return Object.values(map)
    .sort((a, b) => b.total - a.total)
    .slice(0, 12);
});

const openDetails = (sale: any) => {
  selectedSale.value = sale;
  showDetails.value = true;
};

const closeDetails = () => {
  showDetails.value = false;
  selectedSale.value = null;
};

// History Formatters
const formatHistoryQty = (item: any) => {
  const val = item.qty || item.qty_uom || 0;
  return toNumber(val).toFixed(2);
};

const formatHistoryUnit = (item: any) => {
  const u = item.unit_name || item.unit || "unidad";
  return formatUnitLabel(u);
};

const formatHistoryPrice = (item: any) => {
  const val = item.price_unit_uom || item.price_unit || 0;
  return toNumber(val).toFixed(2);
};

const selectedCustomer = computed(() =>
  customers.value.find((customer) => customer.id === customerId.value),
);
const heldSalesCount = computed(() => heldSales.value.length);
const ordersInDbMode = computed(() => ordersStorageMode.value === "db");
const cartItemsCount = computed(() =>
  cart.value.reduce(
    (sum, item) => sum + Math.max(1, Math.trunc(toNumber(item.qty, 1))),
    0,
  ),
);
const defaultHoldSaleName = computed(
  () => `En espera ${heldSales.value.length + 1}`,
);
const messageIsError = computed(() => {
  const text = String(message.value || "").toLowerCase();
  return [
    "no se pudo",
    "error",
    "insuficiente",
    "stock",
    "invál",
    "inval",
    "motivo",
    "ingresa",
    "sin stock",
  ].some((part) => text.includes(part));
});

const checkoutMessageIsError = computed(() => {
  const text = String(checkoutMessage.value || "").toLowerCase();
  return [
    "no se pudo",
    "error",
    "insuficiente",
    "stock",
    "invál",
    "inval",
    "motivo",
  ].some((part) => text.includes(part));
});

const canUseManualDiscount = computed(() => {
  const role = String(userRole.value || "").toLowerCase();
  return role === "owner" || role === "manager";
});

const defaultPaymentMethods = () => [
  { code: "efectivo", label: "Efectivo" },
  { code: "yape", label: "Yape" },
  { code: "plin", label: "Plin" },
  { code: "transferencia", label: "Transferencia" },
  { code: "tarjeta", label: "Tarjeta" },
];

const defaultCustomerGroups = () => [
  { code: "minorista", label: "Minorista" },
  { code: "mayorista", label: "Mayorista" },
  { code: "institucional", label: "Institucional" },
];

const HOLD_STORAGE_KEY = "papeleria_pos_hold_sales_v1";
const DRAFT_STORAGE_KEY = "papeleria_pos_draft_v1";

const isOrdersBackendMissing = (error: any) => {
  const text = String(
    error?.data?.statusMessage || error?.message || "",
  ).toLowerCase();
  return (
    text.includes("sales_orders") ||
    text.includes("sales_order_items") ||
    text.includes("create_sales_order") ||
    text.includes("pay_sales_order") ||
    (text.includes("relation") && text.includes("does not exist")) ||
    (text.includes("function") && text.includes("does not exist"))
  );
};

const toNumber = (value: any, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const round4 = (value: any) => Number(toNumber(value, 0).toFixed(4));
const round2 = (value: any) => Number(toNumber(value, 0).toFixed(2));
const newLocalId = () =>
  `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
const nowIso = () => new Date().toISOString();

const heldSaleTotal = (sale: HeldSale) =>
  sale.items.reduce(
    (sum, item) => sum + toNumber(item.qty, 0) * toNumber(item.price_unit, 0),
    0,
  );

const normalizeCartItem = (item: any): CartItem => ({
  product_id: String(item?.product_id || ""),
  name: String(item?.name || ""),
  sku: item?.sku ? String(item.sku) : null,
  unit_name: normalizeUnitName(item?.unit_name || "unidad"),
  factor_to_base: Math.max(toNumber(item?.factor_to_base, 1), 0.000001),
  qty: Math.max(1, Math.trunc(toNumber(item?.qty, 1))),
  auto_price_unit: round4(item?.auto_price_unit),
  price_unit: round4(item?.price_unit),
  pricing_source: String(item?.pricing_source || "base"),
  pricing_detail:
    typeof item?.pricing_detail === "object" && item?.pricing_detail
      ? item.pricing_detail
      : {},
  manual_discount_pct: Math.max(0, round4(item?.manual_discount_pct)),
  manual_discount_amount: Math.max(0, round4(item?.manual_discount_amount)),
  manual_discount_reason: String(item?.manual_discount_reason || ""),
  manual_price_override:
    item?.manual_price_override === null ||
    typeof item?.manual_price_override === "undefined"
      ? null
      : Math.max(0, round4(item?.manual_price_override)),
});

const cloneCart = (items: CartItem[]) =>
  items.map((item) => normalizeCartItem(item));

const normalizeUnitName = (value: string) =>
  String(value || "")
    .toLowerCase()
    .trim();
const normalizePaymentCode = (value: string) =>
  String(value || "")
    .toLowerCase()
    .trim();

const paymentLabel = (value: string) => {
  const code = normalizePaymentCode(value);
  const match = paymentMethods.value.find((item) => item.code === code);
  return match?.label || String(value || "Efectivo");
};

const customerNameById = (value: string | null) => {
  if (!value) return "Consumidor Final";
  return (
    customers.value.find((customer) => customer.id === value)?.name || "Cliente"
  );
};

const selectedHeldSale = computed(() => {
  if (!selectedHeldSaleId.value) return null;
  return (
    heldSales.value.find((sale) => sale.id === selectedHeldSaleId.value) || null
  );
});

const recentChargedSales = computed(() => salesHistory.value.slice(0, 8));

const customerGroupLabel = (value: string | null | undefined) => {
  const code = String(value || "minorista").toLowerCase();
  const match = customerGroups.value.find((item) => item.code === code);
  return match?.label || "Minorista";
};

const pricingSourceLabel = (value: string | null | undefined) => {
  const source = String(value || "base").toLowerCase();
  const tags: string[] = [];
  if (source.includes("customer_group")) tags.push("Cliente");
  if (source.includes("presentation")) tags.push("Presentación");
  if (source.includes("wholesale")) tags.push("Mayorista");
  if (source.includes("promo")) tags.push("Promoción");
  if (!tags.length) return "Base";
  return tags.join(" + ");
};

const formatUnitLabel = (value: string) => {
  const unit = String(value || "").trim();
  return unit ? unit.charAt(0).toUpperCase() + unit.slice(1) : "Unidad";
};

const formatOrderMoney = (value: any) => `S/ ${toNumber(value, 0).toFixed(2)}`;

const getProductById = (productId: string) =>
  products.value.find((item) => item.id === productId);

const getUomOptions = (productId: string) => productUoms.value[productId] || [];

const getFactor = (productId: string, unitName: string) => {
  const selected = normalizeUnitName(unitName);
  const option = getUomOptions(productId).find(
    (item) => item.unit_name === selected,
  );
  return toNumber(option?.factor_to_base, 1);
};

const getReservedBaseQty = (productId: string, ignoreItem?: CartItem) =>
  cart.value.reduce((sum, item) => {
    if (item.product_id !== productId || item === ignoreItem) return sum;
    return sum + toNumber(item.qty, 0) * toNumber(item.factor_to_base, 1);
  }, 0);

const getStock = (productId: string) => {
  const product = products.value.find((item) => item.id === productId);
  return toNumber(product?.stock_on_hand, 0);
};

const normalizeQtyByStock = (
  item: CartItem,
  index?: number,
  silent = false,
) => {
  const product = getProductById(item.product_id);
  if (!product) return false;

  item.qty = Math.max(1, Math.trunc(toNumber(item.qty, 1)));
  const factor = Math.max(toNumber(item.factor_to_base, 1), 0.000001);
  const reserved = getReservedBaseQty(item.product_id, item);
  const maxQty = Math.floor(
    (toNumber(product.stock_on_hand, 0) - reserved) / factor,
  );

  if (maxQty <= 0) {
    if (typeof index === "number") {
      cart.value.splice(index, 1);
    } else {
      item.qty = 0;
    }
    if (!silent) message.value = "Sin stock disponible para esa presentación.";
    return false;
  }

  if (item.qty > maxQty) {
    item.qty = maxQty;
    if (!silent) message.value = "Cantidad ajustada por stock disponible.";
  }

  return true;
};

const recomputeLineFinalPrice = (item: CartItem, silent = false) => {
  const autoPrice = round4(item.auto_price_unit);
  item.auto_price_unit = autoPrice;

  if (!canUseManualDiscount.value) {
    item.manual_discount_pct = 0;
    item.manual_discount_amount = 0;
    item.manual_discount_reason = "";
    item.manual_price_override = null;
    item.price_unit = autoPrice;
    return;
  }

  const discountPct = Math.min(
    100,
    Math.max(0, toNumber(item.manual_discount_pct, 0)),
  );
  item.manual_discount_pct = discountPct;

  const baseAfterPct = round4(autoPrice * (1 - discountPct / 100));
  let discountAmount = Math.max(0, toNumber(item.manual_discount_amount, 0));
  if (discountAmount > baseAfterPct) {
    discountAmount = baseAfterPct;
    if (!silent) {
      message.value =
        "El descuento en monto fue ajustado para no dejar precio negativo.";
    }
  }
  item.manual_discount_amount = round4(discountAmount);

  const manualOverride =
    item.manual_price_override === null ||
    typeof item.manual_price_override === "undefined"
      ? null
      : Math.max(0, round4(item.manual_price_override));

  if (manualOverride !== null) {
    item.manual_price_override = manualOverride;
    item.price_unit = manualOverride;
  } else {
    item.price_unit = round4(baseAfterPct - item.manual_discount_amount);
  }

  if (
    item.manual_discount_pct === 0 &&
    item.manual_discount_amount === 0 &&
    (item.manual_price_override === null ||
      Math.abs(item.price_unit - autoPrice) <= 0.0001)
  ) {
    item.manual_price_override = null;
    item.manual_discount_reason = "";
  }
};

const applyFallbackPricing = (item: CartItem, product: any) => {
  const factor = getFactor(item.product_id, item.unit_name);
  item.factor_to_base = factor;
  item.auto_price_unit = round4(toNumber(product.sale_price, 0) * factor);
  item.pricing_source = "base";
  item.pricing_detail = { source: "base", factor };
  recomputeLineFinalPrice(item, true);
};

const resolveItemPricing = async (
  item: CartItem,
  index?: number,
  silent = true,
) => {
  const product = getProductById(item.product_id);
  if (!product) return;

  try {
    const qty = Math.max(1, Math.trunc(toNumber(item.qty, 1)));
    item.qty = qty;

    const res = await $fetch<{ pricing: any }>("/api/sales/resolve-pricing", {
      method: "POST",
      body: {
        product_id: item.product_id,
        unit_name: normalizeUnitName(item.unit_name),
        qty_uom: qty,
        customer_id: customerId.value,
        sale_at: new Date().toISOString(),
      },
    });

    const pricing = res?.pricing || {};
    const resolvedUnit = normalizeUnitName(pricing.unit_name || item.unit_name);
    item.unit_name = resolvedUnit;
    item.factor_to_base = Math.max(
      toNumber(pricing.factor, getFactor(item.product_id, resolvedUnit)),
      0.000001,
    );
    item.auto_price_unit = round4(pricing.price_uom);
    item.pricing_source = String(pricing.source || "base");
    item.pricing_detail = pricing;

    if (!normalizeQtyByStock(item, index, silent)) {
      return;
    }
    recomputeLineFinalPrice(item, silent);
  } catch (err: any) {
    applyFallbackPricing(item, product);
    if (!normalizeQtyByStock(item, index, true)) {
      return;
    }
    if (!pricingResolverUnavailable.value) {
      const text = String(err?.data?.statusMessage || err?.message || "");
      if (text.toLowerCase().includes("resolve_sale_item_pricing")) {
        pricingResolverUnavailable.value = true;
        if (!silent) {
          message.value =
            "No se encontró la función de precios automáticos en base de datos. Se usará precio base hasta aplicar el patch.";
        }
      } else if (!silent) {
        message.value =
          text || "No se pudo resolver precio automático del producto.";
      }
    }
  }
};

const refreshCartPricing = async (silent = true) => {
  if (!cart.value.length) return;
  pricingLoading.value = true;
  try {
    let index = 0;
    while (index < cart.value.length) {
      const item = cart.value[index];
      await resolveItemPricing(item, index, silent);
      if (cart.value[index] === item) {
        index += 1;
      }
    }
  } finally {
    pricingLoading.value = false;
  }
};

const syncHeldSaleSelection = () => {
  if (!heldSales.value.length) {
    selectedHeldSaleId.value = null;
    checkoutPaymentMethod.value = paymentMethods.value[0]?.code || "efectivo";
    return;
  }

  if (
    !selectedHeldSaleId.value ||
    !heldSales.value.some((sale) => sale.id === selectedHeldSaleId.value)
  ) {
    selectedHeldSaleId.value = heldSales.value[0].id;
  }

  const selected = heldSales.value.find(
    (sale) => sale.id === selectedHeldSaleId.value,
  );
  if (!selected) return;
  if (
    !paymentMethods.value.some(
      (method) => method.code === checkoutPaymentMethod.value,
    )
  ) {
    checkoutPaymentMethod.value = selected.payment_method;
  }
};

const saveHeldSalesToStorage = () => {
  if (!process.client) return;
  localStorage.setItem(HOLD_STORAGE_KEY, JSON.stringify(heldSales.value));
};

const mapDbOrderItem = (item: any): CartItem => ({
  product_id: String(item?.product_id || ""),
  name: String(item?.products?.name || "Producto"),
  sku: item?.products?.sku ? String(item.products.sku) : null,
  unit_name: normalizeUnitName(item?.unit_name || "unidad"),
  factor_to_base: Math.max(toNumber(item?.factor_to_base, 1), 0.000001),
  qty: Math.max(1, Math.trunc(toNumber(item?.qty_uom, 1))),
  auto_price_unit: round4(item?.auto_price_unit),
  price_unit: round4(item?.price_unit_uom),
  pricing_source: String(item?.pricing_source || "pedido"),
  pricing_detail:
    typeof item?.pricing_detail === "object" && item?.pricing_detail
      ? item.pricing_detail
      : {},
  manual_discount_pct: 0,
  manual_discount_amount: 0,
  manual_discount_reason: "",
  manual_price_override: null,
});

const mapDbOrder = (row: any): HeldSale => {
  const orderCode = row?.order_code ? String(row.order_code) : null;
  const notes = String(row?.notes || "").trim();
  return {
    id: String(row?.id || newLocalId()),
    name: notes || orderCode || "Pedido",
    order_code: orderCode,
    source: "db",
    created_at: String(row?.created_at || nowIso()),
    updated_at: String(row?.updated_at || nowIso()),
    customer_id: row?.customer_id ? String(row.customer_id) : null,
    payment_method: normalizePaymentCode(row?.payment_method || "efectivo"),
    items: Array.isArray(row?.sales_order_items)
      ? row.sales_order_items.map((item: any) => mapDbOrderItem(item))
      : [],
  };
};

const loadHeldSalesFromDb = async () => {
  const res = await $fetch<{ orders: any[] }>("/api/sales/held");

  heldSales.value = (res.orders || [])
    .map((row: any) => mapDbOrder(row))
    .filter((sale: HeldSale) => sale.items.length > 0);
  ordersStorageMode.value = "db";
  syncHeldSaleSelection();
};

const loadHeldSalesFromStorage = () => {
  if (!process.client) return;
  try {
    const raw = localStorage.getItem(HOLD_STORAGE_KEY);
    if (!raw) {
      heldSales.value = [];
      ordersStorageMode.value = "local";
      syncHeldSaleSelection();
      return;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      heldSales.value = [];
      ordersStorageMode.value = "local";
      syncHeldSaleSelection();
      return;
    }
    heldSales.value = parsed
      .map((sale: any) => ({
        id: String(sale?.id || newLocalId()),
        name: String(sale?.name || "En espera"),
        order_code: sale?.order_code ? String(sale.order_code) : null,
        source: "local",
        created_at: String(sale?.created_at || nowIso()),
        updated_at: String(sale?.updated_at || nowIso()),
        customer_id: sale?.customer_id ? String(sale.customer_id) : null,
        payment_method: normalizePaymentCode(
          sale?.payment_method || "efectivo",
        ),
        items: Array.isArray(sale?.items)
          ? sale.items.map((item: any) => normalizeCartItem(item))
          : [],
      }))
      .filter((sale: HeldSale) => sale.items.length > 0)
      .sort((a: HeldSale, b: HeldSale) =>
        b.updated_at.localeCompare(a.updated_at),
      );
    ordersStorageMode.value = "local";
    syncHeldSaleSelection();
  } catch {
    heldSales.value = [];
    ordersStorageMode.value = "local";
    syncHeldSaleSelection();
  }
};

const loadHeldSales = async () => {
  try {
    await loadHeldSalesFromDb();
  } catch (error: any) {
    if (!isOrdersBackendMissing(error)) {
      throw error;
    }
    loadHeldSalesFromStorage();
    if (!ordersFallbackWarned.value) {
      ordersFallbackWarned.value = true;
      message.value =
        "Pedidos en modo local (este equipo). Para compartir pedidos entre empleados, aplica supabase/sales_orders_patch.sql.";
    }
  }
};

const saveDraftToStorage = () => {
  if (!process.client) return;
  if (!cart.value.length) {
    localStorage.removeItem(DRAFT_STORAGE_KEY);
    return;
  }

  const payload = {
    customer_id: customerId.value,
    payment_method: paymentMethod.value,
    items: cloneCart(cart.value),
  };
  localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(payload));
};

const restoreDraftFromStorage = () => {
  if (!process.client) return;
  try {
    const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.items) || !parsed.items.length) return;

    cart.value = parsed.items.map((item: any) => normalizeCartItem(item));
    customerId.value =
      parsed?.customer_id &&
      customers.value.some((customer) => customer.id === parsed.customer_id)
        ? parsed.customer_id
        : null;
    const paymentCode = normalizePaymentCode(
      parsed?.payment_method || "efectivo",
    );
    paymentMethod.value = paymentMethods.value.some(
      (method) => method.code === paymentCode,
    )
      ? paymentCode
      : paymentMethods.value[0]?.code || "efectivo";
  } catch {
    localStorage.removeItem(DRAFT_STORAGE_KEY);
  }
};

const resetCurrentSale = (notify = true) => {
  cart.value = [];
  customerId.value = null;
  paymentMethod.value = paymentMethods.value[0]?.code || "efectivo";
  if (process.client) {
    localStorage.removeItem(DRAFT_STORAGE_KEY);
  }
  if (notify) {
    message.value = "Carrito reiniciado.";
  }
};

const buildOrderPayloadItems = (items: CartItem[]) =>
  items
    .filter((item) => item.product_id && toNumber(item.qty, 0) > 0)
    .map((item) => ({
      product_id: item.product_id,
      qty: Math.max(1, Math.trunc(toNumber(item.qty, 1))),
      unit_name: normalizeUnitName(item.unit_name),
      price_unit: round4(item.price_unit),
    }));

const saveCurrentSaleAsHoldLocal = (name: string) => {
  const stamp = nowIso();
  heldSales.value = [
    {
      id: newLocalId(),
      name,
      order_code: null,
      source: "local",
      created_at: stamp,
      updated_at: stamp,
      customer_id: customerId.value,
      payment_method: paymentMethod.value,
      items: cloneCart(cart.value),
    },
    ...heldSales.value,
  ];
  saveHeldSalesToStorage();
  syncHeldSaleSelection();
  holdName.value = "";
  resetCurrentSale(false);
};

const saveCurrentSaleAsHold = async () => {
  if (!cart.value.length) {
    message.value = "No hay productos para guardar en espera.";
    return;
  }

  await refreshCartPricing(true);

  const name = String(holdName.value || "").trim() || defaultHoldSaleName.value;
  const payloadItems = buildOrderPayloadItems(cart.value);

  if (!payloadItems.length) {
    message.value = "No hay productos válidos para guardar en pedido.";
    return;
  }

  if (ordersInDbMode.value) {
    try {
      await $fetch("/api/sales/hold", {
        method: "POST",
        body: {
          customer_id: customerId.value,
          payment_method: paymentMethod.value,
          items: payloadItems,
          notes: name,
        },
      });
      holdName.value = "";
      resetCurrentSale(false);
      await loadHeldSalesFromDb();
      message.value = `Pedido guardado: ${name}.`;
      return;
    } catch (error: any) {
      if (!isOrdersBackendMissing(error)) {
        message.value =
          error?.data?.statusMessage ||
          error?.message ||
          "No se pudo guardar el pedido.";
        return;
      }
      ordersStorageMode.value = "local";
      ordersFallbackWarned.value = true;
    }
  }

  saveCurrentSaleAsHoldLocal(name);
  message.value = `Pedido guardado en este equipo: ${name}.`;
};

const loadHeldSale = async (holdId: string) => {
  const selected = heldSales.value.find((sale) => sale.id === holdId);
  if (!selected) {
    message.value = "No se encontró la venta en espera.";
    return;
  }

  cart.value = cloneCart(selected.items);
  customerId.value =
    selected.customer_id &&
    customers.value.some((customer) => customer.id === selected.customer_id)
      ? selected.customer_id
      : null;
  paymentMethod.value = paymentMethods.value.some(
    (method) => method.code === selected.payment_method,
  )
    ? selected.payment_method
    : paymentMethods.value[0]?.code || "efectivo";

  if (selected.source === "db") {
    try {
      await $fetch(`/api/sales/held/${holdId}/delete`, { method: "POST" });
    } catch (err: any) {
      message.value =
        err?.data?.statusMessage ||
        err?.message ||
        "No se pudo abrir el pedido para edición.";
      return;
    }
    await loadHeldSales();
  } else {
    heldSales.value = heldSales.value.filter((sale) => sale.id !== holdId);
    saveHeldSalesToStorage();
    syncHeldSaleSelection();
  }

  await refreshCartPricing(true);
  message.value = `Pedido cargado: ${selected.name}.`;
};

const removeHeldSale = async (holdId: string) => {
  const selected = heldSales.value.find((sale) => sale.id === holdId);
  if (!selected) return;

  if (selected.source === "db") {
    try {
      await $fetch(`/api/sales/held/${holdId}/delete`, { method: "POST" });
    } catch (err: any) {
      checkoutMessage.value =
        err?.data?.statusMessage ||
        err?.message ||
        "No se pudo eliminar el pedido.";
      return;
    }
    await loadHeldSales();
    checkoutMessage.value = "Pedido eliminado.";
    return;
  }

  heldSales.value = heldSales.value.filter((sale) => sale.id !== holdId);
  saveHeldSalesToStorage();
  syncHeldSaleSelection();
  checkoutMessage.value = "Pedido eliminado.";
};

const selectHeldSale = (holdId: string) => {
  const selected = heldSales.value.find((sale) => sale.id === holdId);
  if (!selected) return;
  selectedHeldSaleId.value = selected.id;
  checkoutPaymentMethod.value = paymentMethods.value.some(
    (method) => method.code === selected.payment_method,
  )
    ? selected.payment_method
    : paymentMethods.value[0]?.code || "efectivo";
  checkoutMessage.value = "";
};

const printLatestReceipt = () => {
  if (!process.client || !latestReceipt.value) return;
  window.print();
};

const incrementItemQty = async (item: CartItem, index: number) => {
  item.qty = Math.max(1, Math.trunc(toNumber(item.qty, 1))) + 1;
  await onCartQtyChange(item, index);
};

const decrementItemQty = async (item: CartItem, index: number) => {
  const current = Math.max(1, Math.trunc(toNumber(item.qty, 1)));
  if (current <= 1) {
    removeFromCart(index);
    return;
  }
  item.qty = current - 1;
  await onCartQtyChange(item, index);
};

const startEditingPrice = async (index: number) => {
  if (!canUseManualDiscount.value) return;
  editingPriceIndex.value = index;
  await nextTick();
  if (!process.client) return;
  const input = document.getElementById(
    `price-input-${index}`,
  ) as HTMLInputElement | null;
  input?.focus();
  input?.select();
};

const stopEditingPrice = (item: CartItem) => {
  onManualUnitPriceChange(item);
  editingPriceIndex.value = null;
};

const focusProductSearch = () => {
  if (!process.client) return;
  requestAnimationFrame(() => {
    searchInputRef.value?.focus();
    searchInputRef.value?.select();
  });
};

const scrollActiveProductIntoView = () => {
  if (!process.client) return;
  requestAnimationFrame(() => {
    const container = productListRef.value;
    if (!container) return;
    const el = container.querySelector<HTMLElement>(
      `[data-pos-product=\"${activeProductIndex.value}\"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  });
};

const findProductBySku = (raw: string) => {
  const term = String(raw || "")
    .trim()
    .toLowerCase();
  if (!term) return null;
  return (
    products.value.find(
      (product) =>
        String(product?.sku || "")
          .trim()
          .toLowerCase() === term,
    ) || null
  );
};

const handleSearchKeydown = (event: KeyboardEvent) => {
  if (activeTab.value !== "pos") return;

  const list = visibleProducts.value;
  if (event.key === "ArrowDown") {
    if (!list.length) return;
    event.preventDefault();
    activeProductIndex.value = Math.min(
      activeProductIndex.value + 1,
      list.length - 1,
    );
    scrollActiveProductIntoView();
    return;
  }

  if (event.key === "ArrowUp") {
    if (!list.length) return;
    event.preventDefault();
    activeProductIndex.value = Math.max(activeProductIndex.value - 1, 0);
    scrollActiveProductIntoView();
    return;
  }

  if (event.key === "Enter") {
    const term = query.value.trim();
    if (!term) return;
    event.preventDefault();

    const exact = findProductBySku(term);
    if (exact) {
      addToCart(exact);
      return;
    }

    const selected = list[activeProductIndex.value] || list[0];
    if (selected) addToCart(selected);
    return;
  }

  if (event.key === "Escape") {
    if (!query.value.trim()) return;
    event.preventDefault();
    query.value = "";
    activeProductIndex.value = 0;
  }
};

const handlePosHotkeys = (event: KeyboardEvent) => {
  if (activeTab.value !== "pos") return;
  if (event.key === "F2") {
    event.preventDefault();
    focusProductSearch();
    return;
  }
  if (event.key === "F4") {
    event.preventDefault();
    void saveCurrentSaleAsHold();
    return;
  }
  if (event.key === "F8") {
    event.preventDefault();
    if (!loading.value && !pricingLoading.value && cart.value.length) {
      void submitSale();
    }
  }
};

const loadSessionRole = async () => {
  try {
    const { role } = await $fetch<{ role: string }>("/api/auth/me");
    userRole.value = String(role || "cashier");
  } catch {
    userRole.value = "";
  }
};

const loadData = async () => {
  message.value = "";
  await loadSessionRole();

  let conversions: any[] = [];
  let paymentData: any[] = [];
  let customerGroupData: any[] = [];
  let historyData: any[] = [];

  try {
    const data = await $fetch<{
      products: any[];
      conversions: any[];
      paymentMethods: any[];
      customers: any[];
      customerGroups: any[];
      salesHistory: any[];
    }>("/api/sales/page");

    products.value = data.products || [];
    conversions = Array.isArray(data.conversions) ? data.conversions : [];
    paymentData = Array.isArray(data.paymentMethods) ? data.paymentMethods : [];
    customers.value = data.customers || [];
    customerGroupData = Array.isArray(data.customerGroups)
      ? data.customerGroups
      : [];
    historyData = Array.isArray(data.salesHistory) ? data.salesHistory : [];
  } catch (err: any) {
    message.value =
      err?.data?.statusMessage || err?.message || "No se pudo cargar ventas.";
    return;
  }

  customerGroups.value = customerGroupData.length
    ? customerGroupData
    : defaultCustomerGroups();

  const map: Record<
    string,
    Array<{ unit_name: string; factor_to_base: number }>
  > = {};
  for (const product of products.value) {
    map[product.id] = [
      {
        unit_name: normalizeUnitName(product.unit || "unidad"),
        factor_to_base: 1,
      },
    ];
  }

  for (const row of conversions || []) {
    const productId = row.product_id;
    const unitName = normalizeUnitName(row.unit_name || "");
    const factor = toNumber(row.factor_to_base, 0);
    if (!productId || !unitName || factor <= 0) continue;
    if (!map[productId]) map[productId] = [];
    if (map[productId].some((opt) => opt.unit_name === unitName)) continue;
    map[productId].push({ unit_name: unitName, factor_to_base: factor });
  }
  productUoms.value = map;

  paymentMethods.value = (paymentData || []).map((item) => ({
    code: normalizePaymentCode(item.code || ""),
    label: String(item.label || item.code || ""),
  }));
  if (!paymentMethods.value.length) {
    paymentMethods.value = defaultPaymentMethods();
  }

  if (!paymentMethods.value.some((item) => item.code === paymentMethod.value)) {
    paymentMethod.value = paymentMethods.value[0]?.code || "efectivo";
  }
  if (
    !paymentMethods.value.some(
      (item) => item.code === checkoutPaymentMethod.value,
    )
  ) {
    checkoutPaymentMethod.value = paymentMethods.value[0]?.code || "efectivo";
  }

  salesHistory.value = historyData || [];

  try {
    await loadHeldSales();
  } catch (error: any) {
    heldSales.value = [];
    syncHeldSaleSelection();
    message.value =
      error?.data?.statusMessage ||
      error?.message ||
      "No se pudieron cargar los pedidos pendientes.";
  }
  restoreDraftFromStorage();
  syncHeldSaleSelection();
  await refreshCartPricing(true);
};

const MAX_PRODUCT_RESULTS = 60;

const normalizeFilterText = (value: any) =>
  String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();

const filterKeywordMap: Record<ProductFilterKey, string[]> = {
  todo: [],
  cuadernos: [
    "cuaderno",
    "cuadernos",
    "libreta",
    "anillado",
    "reglon",
    "rayado",
    "hojas",
  ],
  papel: [
    "papel",
    "bond",
    "opalina",
    "cartulina",
    "lustre",
    "fotografico",
    "couche",
    "kraft",
    "etiqueta",
    "resma",
  ],
  lapices: [
    "lapiz",
    "lapices",
    "lapicero",
    "boligrafo",
    "marcador",
    "plumon",
    "resaltador",
    "portaminas",
  ],
  arte: [
    "arte",
    "dibujo",
    "acuarela",
    "tempera",
    "pintura",
    "pincel",
    "paleta",
    "plastilina",
    "crayon",
  ],
  regalos: [
    "regalo",
    "mochila",
    "cartuchera",
    "adorno",
    "peluche",
    "sorpresa",
    "juguete",
    "capibara",
  ],
};

const matchesProductFilter = (product: any, filterKey: ProductFilterKey) => {
  if (filterKey === "todo") return true;

  const name = normalizeFilterText(product?.name);
  const sku = normalizeFilterText(product?.sku);
  const brand = normalizeFilterText(product?.brand);
  const type = normalizeFilterText(product?.product_type);
  const haystack = `${name} ${sku} ${brand} ${type}`;

  return filterKeywordMap[filterKey].some(
    (keyword) => haystack.includes(keyword),
  );
};

const scoreProductMatch = (product: any, term: string) => {
  const name = String(product?.name || "").toLowerCase();
  const sku = String(product?.sku || "").toLowerCase();
  const rawTerm = term.trim().toLowerCase();

  // 1. Coincidencia Exacta de SKU (Prioridad Máxima)
  if (sku === rawTerm) return 1000;

  // 2. Coincidencia Parcial de SKU (Alta Prioridad)
  if (sku.startsWith(rawTerm)) return 800;

  // 3. Búsqueda por Palabras (Token-based)
  // Permite que "cuaderno 100" encuentre "cuaderno layconsa 100 hojas"
  const tokens = rawTerm.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return 0;

  const haystack = `${name} ${sku}`;
  let score = 0;
  let matchesAll = true;

  for (const token of tokens) {
    if (!haystack.includes(token)) {
      matchesAll = false;
      break;
    }
    // Bonificación por inicio de palabra o coincidencia exacta de token
    if (name.startsWith(token)) score += 50;
    if (haystack.includes(` ${token}`) || haystack.startsWith(token)) {
      score += 20;
    }
    score += 10;
  }

  if (!matchesAll) return 0;

  return score;
};

const filteredProducts = computed(() => {
  const term = query.value.toLowerCase().trim();
  if (!term) return [];

  return products.value
    .filter((product) => matchesProductFilter(product, activeProductFilter.value))
    .map((product) => ({ product, score: scoreProductMatch(product, term) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return String(a.product?.name || "").localeCompare(
        String(b.product?.name || ""),
        "es",
      );
    })
    .slice(0, MAX_PRODUCT_RESULTS)
    .map((row) => row.product);
});

const defaultProducts = computed(() => {
  const list = products.value.filter((product) =>
    matchesProductFilter(product, activeProductFilter.value),
  );
  list.sort((a, b) => {
    const stockDiff =
      toNumber(b?.stock_on_hand, 0) - toNumber(a?.stock_on_hand, 0);
    if (stockDiff !== 0) return stockDiff;
    return String(a?.name || "").localeCompare(String(b?.name || ""), "es");
  });
  return list.slice(0, 40);
});

const visibleProducts = computed(() => {
  const term = query.value.trim();
  if (term) return filteredProducts.value;
  return defaultProducts.value;
});

const hasProductSearch = computed(() => query.value.trim().length > 0);

const addToCart = (product: any) => {
  message.value = "";
  const unitName = normalizeUnitName(product.unit || "unidad");
  const existingIndex = cart.value.findIndex(
    (item) => item.product_id === product.id && item.unit_name === unitName,
  );

  if (existingIndex >= 0) {
    cart.value[existingIndex].qty += 1;
    query.value = "";
    void onCartQtyChange(cart.value[existingIndex], existingIndex);
    focusProductSearch();
    return;
  }

  if (toNumber(product.stock_on_hand, 0) <= 0) {
    message.value = "Producto sin stock disponible.";
    return;
  }

  const factor = getFactor(product.id, unitName);
  const item: CartItem = {
    product_id: product.id,
    name: product.name,
    sku: product.sku || null,
    unit_name: unitName,
    factor_to_base: factor,
    qty: 1,
    auto_price_unit: round4(toNumber(product.sale_price, 0) * factor),
    price_unit: round4(toNumber(product.sale_price, 0) * factor),
    pricing_source: "base",
    pricing_detail: { source: "base" },
    manual_discount_pct: 0,
    manual_discount_amount: 0,
    manual_discount_reason: "",
    manual_price_override: null,
  };

  cart.value.push(item);
  query.value = "";
  void resolveItemPricing(item, cart.value.length - 1, true);
  focusProductSearch();
};

const removeFromCart = (index: number) => {
  cart.value.splice(index, 1);
};

const onCartQtyChange = async (item: CartItem, index?: number) => {
  item.qty = Math.max(1, Math.trunc(toNumber(item.qty, 1)));
  await resolveItemPricing(item, index, true);
};

const onCartUnitChange = async (item: CartItem, index: number) => {
  const product = getProductById(item.product_id);
  if (!product) return;

  item.unit_name = normalizeUnitName(
    item.unit_name || product.unit || "unidad",
  );

  const duplicateIndex = cart.value.findIndex(
    (line, lineIndex) =>
      lineIndex !== index &&
      line.product_id === item.product_id &&
      line.unit_name === item.unit_name,
  );

  if (duplicateIndex >= 0) {
    cart.value[duplicateIndex].qty += toNumber(item.qty, 0);
    cart.value.splice(index, 1);
    const targetIndex =
      duplicateIndex > index ? duplicateIndex - 1 : duplicateIndex;
    await onCartQtyChange(cart.value[targetIndex], targetIndex);
    return;
  }

  item.factor_to_base = getFactor(item.product_id, item.unit_name);
  await onCartQtyChange(item, index);
};

const onManualDiscountChange = (item: CartItem) => {
  if (!canUseManualDiscount.value) return;
  item.manual_price_override = null;
  item.manual_discount_pct = Math.max(0, toNumber(item.manual_discount_pct, 0));
  item.manual_discount_amount = Math.max(
    0,
    toNumber(item.manual_discount_amount, 0),
  );
  recomputeLineFinalPrice(item, false);
};

const onManualUnitPriceChange = (item: CartItem) => {
  item.manual_discount_pct = 0;
  item.manual_discount_amount = 0;
  item.manual_price_override = round4(
    Math.max(0, toNumber(item.price_unit, item.auto_price_unit)),
  );
  recomputeLineFinalPrice(item, false);
  if (
    Math.abs(toNumber(item.price_unit, 0) - toNumber(item.auto_price_unit, 0)) >
      0.0001 &&
    !item.manual_discount_reason
  ) {
    item.manual_discount_reason = "Precio manual de pedido";
  }
};

const total = computed(() =>
  cart.value.reduce(
    (sum, item) => sum + toNumber(item.qty, 0) * toNumber(item.price_unit, 0),
    0,
  ),
);

const submitSale = async (): Promise<SaleSubmitResult> => {
  message.value = "";
  loading.value = true;
  try {
    await refreshCartPricing(true);

    const activeItems = cart.value.filter(
      (item) => item.product_id && toNumber(item.qty, 0) > 0,
    );
    if (!activeItems.length) {
      message.value = "Agrega productos al carrito.";
      return { ok: false, saleId: null, error: message.value };
    }

    // Validation for manual price reasons
    for (const item of activeItems) {
      const hasDiscount =
        toNumber(item.manual_discount_pct, 0) > 0 ||
        toNumber(item.manual_discount_amount, 0) > 0;
      const hasManualPriceChange =
        Math.abs(
          toNumber(item.price_unit, 0) - toNumber(item.auto_price_unit, 0),
        ) > 0.0001;
      if (
        (hasDiscount || hasManualPriceChange) &&
        !String(item.manual_discount_reason || "").trim()
      ) {
        // Auto-fill reason if missing to avoid blocking double-click flow
        // or we could block. Given "double click" is explicit, let's auto-fill if empty.
        item.manual_discount_reason =
          item.manual_discount_reason || "Ajuste manual";
      }
    }

    const byProduct: Record<string, number> = {};
    for (const item of activeItems) {
      const factor = Math.max(toNumber(item.factor_to_base, 1), 0.000001);
      byProduct[item.product_id] =
        (byProduct[item.product_id] || 0) +
        Math.max(1, Math.trunc(toNumber(item.qty, 1))) * factor;
    }

    for (const [productId, qtyBase] of Object.entries(byProduct)) {
      if (qtyBase > getStock(productId)) {
        const product = getProductById(productId);
        message.value = `Stock insuficiente para ${product?.name || "un producto"}.`;
        return { ok: false, saleId: null, error: message.value };
      }
    }

    const cleaned = activeItems.map((item) => ({
      product_id: item.product_id,
      qty: Math.max(1, Math.trunc(toNumber(item.qty, 1))),
      unit_name: normalizeUnitName(item.unit_name),
      price_unit: round4(item.price_unit),
      manual_discount_pct: round4(item.manual_discount_pct),
      manual_discount_amount: round4(item.manual_discount_amount),
      manual_discount_reason:
        String(item.manual_discount_reason || "").trim() || null,
    }));

    const res = await $fetch<{ saleId: string | null }>(
      "/api/sales/create-sale",
      {
        method: "POST",
        body: {
          customer_id: customerId.value,
          payment_method: paymentMethod.value,
          items: cleaned,
        },
      },
    );

    const saleId = res?.saleId ? String(res.saleId) : null;
    latestReceipt.value = {
      saleId,
      holdName: "Venta inmediata",
      paidAt: nowIso(),
      paymentMethod: paymentMethod.value,
      customerName: customerNameById(customerId.value),
      total: round2(total.value),
      items: cloneCart(activeItems),
    };

    message.value = "Venta registrada correctamente.";
    cart.value = [];
    customerId.value = null;
    paymentMethod.value = paymentMethods.value[0]?.code || "efectivo";
    if (process.client) {
      localStorage.removeItem(DRAFT_STORAGE_KEY);
    }
    await loadData();
    focusProductSearch();
    return { ok: true, saleId, error: null };
  } catch (err: any) {
    message.value =
      err?.data?.statusMessage ||
      err?.message ||
      "No se pudo registrar la venta.";
    return { ok: false, saleId: null, error: message.value };
  } finally {
    loading.value = false;
  }
};

const chargeSelectedHeldSale = async () => {
  const selected = selectedHeldSale.value;
  if (!selected) {
    checkoutMessage.value = "Selecciona un pedido para cobrar.";
    return;
  }

  checkoutLoading.value = true;
  checkoutMessage.value = "";

  try {
    const paymentCode = paymentMethods.value.some(
      (method) => method.code === checkoutPaymentMethod.value,
    )
      ? checkoutPaymentMethod.value
      : selected.payment_method;

    if (selected.source === "db") {
      const res = await $fetch<{ saleId: string | null }>(
        `/api/sales/held/${selected.id}/pay`,
        {
          method: "POST",
          body: {
            payment_method: paymentCode,
          },
        },
      );

      latestReceipt.value = {
        saleId: res?.saleId ? String(res.saleId) : null,
        holdName: selected.name,
        paidAt: nowIso(),
        paymentMethod: paymentCode,
        customerName: customerNameById(selected.customer_id),
        total: round2(heldSaleTotal(selected)),
        items: cloneCart(selected.items),
      };

      await loadData();
      checkoutMessage.value = "Cobro registrado y recibo generado.";
      return;
    }

    const backupCart = cloneCart(cart.value);
    const backupCustomerId = customerId.value;
    const backupPaymentMethod = paymentMethod.value;
    const backupMessage = message.value;

    cart.value = cloneCart(selected.items);
    customerId.value =
      selected.customer_id &&
      customers.value.some((customer) => customer.id === selected.customer_id)
        ? selected.customer_id
        : null;
    paymentMethod.value = paymentCode;

    const result = await submitSale();
    const saleError = result.error || message.value;

    cart.value = backupCart;
    customerId.value = backupCustomerId;
    paymentMethod.value = backupPaymentMethod;
    message.value = backupMessage;
    saveDraftToStorage();

    if (!result.ok) {
      checkoutMessage.value = saleError || "No se pudo cobrar el pedido.";
      return;
    }

    latestReceipt.value = {
      saleId: result.saleId,
      holdName: selected.name,
      paidAt: nowIso(),
      paymentMethod: paymentCode,
      customerName: customerNameById(selected.customer_id),
      total: round2(heldSaleTotal(selected)),
      items: cloneCart(selected.items),
    };

    heldSales.value = heldSales.value.filter((sale) => sale.id !== selected.id);
    saveHeldSalesToStorage();
    syncHeldSaleSelection();
    checkoutMessage.value = "Cobro registrado y recibo generado.";
  } catch (error: any) {
    if (selected.source === "db" && isOrdersBackendMissing(error)) {
      ordersStorageMode.value = "local";
      loadHeldSalesFromStorage();
      checkoutMessage.value =
        "No se encontró el módulo de pedidos en la base de datos. Se activó modo local en este equipo.";
      return;
    }
    checkoutMessage.value =
      error?.data?.statusMessage ||
      error?.message ||
      "No se pudo cobrar el pedido.";
  } finally {
    checkoutLoading.value = false;
  }
};

const editHeldSale = async (holdId: string) => {
  if (!holdId) return;
  await loadHeldSale(holdId);
  activeTab.value = "pos";
};

const editSelectedHeldSale = async () => {
  if (!selectedHeldSale.value) return;
  await editHeldSale(selectedHeldSale.value.id);
};

const parseRouteTab = (value: unknown): SalesTab => {
  const normalized = String(value || "")
    .toLowerCase()
    .trim();

  if (normalized === "checkout" || normalized === "pedidos") return "checkout";
  if (normalized === "history" || normalized === "historial") return "history";
  if (normalized === "reports" || normalized === "reportes") return "reports";
  return "pos";
};

watch(customerId, () => {
  void refreshCartPricing(true);
});

watch(query, () => {
  activeProductIndex.value = 0;
});

watch(activeProductFilter, () => {
  activeProductIndex.value = 0;
});

watch(visibleProducts, (list) => {
  if (!list.length) {
    activeProductIndex.value = 0;
    return;
  }
  if (activeProductIndex.value >= list.length) {
    activeProductIndex.value = 0;
  }
});

watch(
  [cart, customerId, paymentMethod],
  () => {
    saveDraftToStorage();
  },
  { deep: true },
);

watch(selectedHeldSaleId, () => {
  const selected = selectedHeldSale.value;
  if (!selected) return;
  checkoutPaymentMethod.value = paymentMethods.value.some(
    (method) => method.code === selected.payment_method,
  )
    ? selected.payment_method
    : paymentMethods.value[0]?.code || "efectivo";
});

watch(
  () => route.query.view,
  (view) => {
    activeTab.value = parseRouteTab(view);
  },
);

watch(activeTab, (tab) => {
  if (tab === "pos") {
    focusProductSearch();
  }
  if (tab !== "history" && showDetails.value) {
    closeDetails();
  }
});

onMounted(async () => {
  await loadData();
  activeTab.value = parseRouteTab(route.query.view);
  if (activeTab.value === "pos") {
    focusProductSearch();
  }
  if (process.client) {
    window.addEventListener("keydown", handlePosHotkeys);
  }
});

onBeforeUnmount(() => {
  if (process.client) {
    window.removeEventListener("keydown", handlePosHotkeys);
  }
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div
      v-if="activeTab === 'pos'"
      class="grid min-h-0 flex-1 grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_420px]"
    >
      <section class="flex min-h-0 flex-col gap-5">
        <div class="flex flex-wrap items-center gap-2">
          <button
            v-for="filter in productFilterOptions"
            :key="filter.key"
            class="rounded-xl px-4 py-2 text-sm font-bold shadow-sm transition-all"
            :class="
              activeProductFilter === filter.key
                ? 'bg-slate-800 text-white shadow-md'
                : 'border border-gray-200 bg-white text-slate-600 hover:bg-gray-50'
            "
            @click="activeProductFilter = filter.key"
          >
            {{ filter.label }}
          </button>
        </div>

        <div
          class="w-full max-w-4xl rounded-2xl border bg-white/95 p-4 shadow-sm backdrop-blur-sm transition-all"
          :class="
            hasProductSearch
              ? 'border-indigo-200 shadow-lg shadow-indigo-500/10'
              : 'border-gray-200'
          "
        >
          <div class="relative">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              class="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              ref="searchInputRef"
              v-model="query"
              class="h-14 w-full rounded-xl border border-gray-200 bg-white pl-12 pr-12 text-xl font-semibold text-slate-700 outline-none transition-all placeholder:text-slate-400 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/15"
              type="text"
              autocomplete="off"
              placeholder="Buscar producto por nombre o SKU..."
              @keydown="handleSearchKeydown"
            />
            <button
              v-if="query"
              class="absolute right-3 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-slate-400 transition-all hover:bg-slate-100 hover:text-slate-700"
              @click="
                query = '';
                focusProductSearch();
              "
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div
          ref="productListRef"
          class="grid min-h-0 flex-1 auto-rows-max content-start grid-cols-2 gap-4 overflow-y-auto pr-2 md:grid-cols-3 xl:grid-cols-4"
        >
          <button
            v-for="(product, idx) in visibleProducts"
            :key="product.id"
            type="button"
            class="group self-start rounded-2xl border bg-white p-4 text-left shadow-sm transition-all"
            :class="
              Number(product.stock_on_hand || 0) <= 0
                ? 'cursor-not-allowed border-gray-200 opacity-60'
                : idx === activeProductIndex
                  ? 'border-indigo-200 ring-2 ring-indigo-500/20 hover:-translate-y-1 hover:shadow-lg'
                  : 'border-gray-100 hover:-translate-y-1 hover:border-indigo-100 hover:shadow-lg'
            "
            :data-pos-product="idx"
            :disabled="Number(product.stock_on_hand || 0) <= 0"
            @click="addToCart(product)"
          >
            <div
              class="mb-3 flex h-24 items-center justify-center rounded-xl bg-slate-100 text-3xl transition-transform group-hover:scale-105"
            >
              {{ ["📒", "🎒", "✏️", "🎨", "✂️", "🖊️", "📏", "🧴"][idx % 8] }}
            </div>
            <p class="line-clamp-2 min-h-[48px] text-sm font-bold text-slate-800">
              {{ product.name }}
            </p>
            <p class="mt-1 text-3xl leading-none text-indigo-600">
              {{ formatOrderMoney(product.sale_price) }}
            </p>
          </button>

          <div
            v-if="!visibleProducts.length"
            class="col-span-full rounded-2xl border-2 border-dashed border-gray-200 bg-white px-4 py-12 text-center text-sm font-medium text-slate-500"
          >
            No se encontraron productos.
          </div>
        </div>
      </section>

      <aside
        class="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-lg lg:max-h-full"
      >
        <div class="border-b border-gray-100 bg-white p-6">
          <h3 class="text-lg font-bold text-slate-800">Ticket Actual</h3>
          <p class="mt-1 text-xs font-bold uppercase tracking-wide text-slate-400">
            #ORD-{{ String(Date.now()).slice(-4) }}
          </p>
        </div>

        <div class="flex-1 space-y-3 overflow-y-auto p-4">
          <article
            v-for="(item, index) in cart"
            :key="`${item.product_id}-${item.unit_name}-${index}`"
            class="flex items-center justify-between gap-3 rounded-xl border border-transparent p-3 transition-all hover:border-gray-100 hover:bg-slate-50"
          >
            <div class="flex min-w-0 items-center gap-3">
              <div
                class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-lg text-indigo-600"
              >
                {{ ["📒", "🎒", "✏️", "🎨", "✂️", "🖊️", "📏", "🧴"][index % 8] }}
              </div>
              <div class="min-w-0">
                <p class="truncate text-sm font-bold text-slate-800">
                  {{ item.name }}
                </p>
                <p class="text-xs text-slate-500">
                  x{{ Number(item.qty).toFixed(0) }} unidades
                </p>
                <div class="mt-1 flex items-center gap-1">
                  <button
                    class="inline-flex h-5 w-5 items-center justify-center rounded bg-slate-100 text-xs font-bold text-slate-500 hover:bg-slate-200"
                    @click="decrementItemQty(item, index)"
                  >
                    -
                  </button>
                  <input
                    v-model.number="item.qty"
                    type="number"
                    class="w-10 rounded border border-gray-200 bg-white px-1 py-0.5 text-center text-xs font-semibold text-slate-700 focus:border-indigo-500 focus:outline-none"
                    @change="onCartQtyChange(item, index)"
                  />
                  <button
                    class="inline-flex h-5 w-5 items-center justify-center rounded bg-slate-100 text-xs font-bold text-slate-500 hover:bg-slate-200"
                    @click="incrementItemQty(item, index)"
                  >
                    +
                  </button>
                </div>
              </div>
            </div>

            <div class="text-right">
              <p
                class="cursor-pointer text-sm font-bold text-slate-900"
                title="Doble click para editar precio"
                @dblclick="startEditingPrice(index)"
              >
                {{
                  formatOrderMoney(
                    Number(item.qty || 0) * Number(item.price_unit || 0),
                  )
                }}
              </p>
              <input
                v-if="editingPriceIndex === index"
                :id="`price-input-${index}`"
                v-model.number="item.price_unit"
                type="number"
                step="0.01"
                class="mt-1 w-24 rounded border border-emerald-300 bg-white px-2 py-1 text-right text-xs font-bold text-emerald-600 focus:border-emerald-500 focus:outline-none"
                @blur="stopEditingPrice(item)"
                @keydown.enter="stopEditingPrice(item)"
              />
              <button
                class="mt-1 block w-full text-right text-xs text-rose-500 hover:text-rose-600"
                @click="removeFromCart(index)"
              >
                Quitar
              </button>
            </div>
          </article>

          <div
            v-if="!cart.length"
            class="flex h-full min-h-[220px] items-center justify-center rounded-xl border-2 border-dashed border-gray-200 bg-slate-50 text-center text-sm text-slate-500"
          >
            Agrega productos para iniciar la venta.
          </div>
        </div>

        <footer class="space-y-4 border-t border-gray-100 bg-slate-50 p-6">
          <div class="flex items-center justify-between text-sm font-bold text-slate-500">
            <span>Subtotal</span>
            <span>{{ formatOrderMoney(total) }}</span>
          </div>
          <div class="flex items-center justify-between text-[2rem] font-black text-slate-900">
            <span>Total</span>
            <span>{{ formatOrderMoney(total) }}</span>
          </div>

          <div
            v-if="message"
            class="rounded-xl border px-3 py-2 text-sm font-medium"
            :class="
              messageIsError
                ? 'border-rose-200 bg-rose-50 text-rose-600'
                : 'border-emerald-200 bg-emerald-50 text-emerald-600'
            "
          >
            {{ message }}
          </div>

          <button
            class="w-full rounded-xl bg-indigo-600 px-4 py-4 text-xl font-bold text-white shadow-lg shadow-indigo-500/30 transition-all hover:bg-indigo-700 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="!cart.length || loading"
            @click="submitSale"
          >
            {{ loading ? "Procesando..." : "Cobrar" }}
          </button>
        </footer>
      </aside>
    </div>

    <div
      v-if="activeTab === 'history'"
      class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-sm"
    >
      <header class="border-b border-gray-100 p-5 sm:p-6">
        <h3 class="text-lg font-bold text-slate-800">Historial de Ventas</h3>
        <p class="text-sm text-slate-500">Transacciones recientes registradas</p>
      </header>

      <div class="flex-1 overflow-y-auto p-5 sm:p-6">
        <div class="mb-6 grid grid-cols-1 gap-4 md:grid-cols-3">
          <div class="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
            <p class="text-xs font-bold uppercase tracking-widest text-slate-400">
              Total ventas
            </p>
            <p class="mt-1 text-3xl font-bold text-slate-800">
              {{ totalSalesCount }}
            </p>
          </div>
          <div class="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
            <p class="text-xs font-bold uppercase tracking-widest text-slate-400">
              Items vendidos
            </p>
            <p class="mt-1 text-3xl font-bold text-slate-800">
              {{ totalItemsSold }}
            </p>
          </div>
          <div class="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
            <p class="text-xs font-bold uppercase tracking-widest text-emerald-500">
              Ingresos
            </p>
            <p class="mt-1 text-3xl font-bold text-emerald-600">
              S/ {{ totalRevenue.toFixed(2) }}
            </p>
          </div>
        </div>

        <div class="overflow-x-auto rounded-2xl border border-gray-100 bg-white shadow-sm">
          <table class="min-w-[760px] w-full text-left">
            <thead
              class="bg-slate-50 text-xs font-bold uppercase tracking-wider text-slate-400"
            >
              <tr>
                <th class="px-8 py-5">Fecha</th>
                <th class="px-8 py-5">Cliente</th>
                <th class="px-8 py-5">Metodo</th>
                <th class="px-8 py-5 text-center">Items</th>
                <th class="px-8 py-5 text-right">Total</th>
                <th class="px-8 py-5 text-center">Accion</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-50">
              <tr
                v-for="sale in salesHistory"
                :key="sale.id"
                class="border-b border-gray-50 bg-white transition-colors hover:bg-indigo-50/30"
              >
                <td class="px-8 py-5 text-sm font-medium text-slate-600">
                  {{
                    new Date(sale.created_at).toLocaleDateString("es-PE", {
                      day: "2-digit",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })
                  }}
                </td>
                <td class="px-8 py-5 text-sm">
                  <span
                    :class="
                      sale.customers
                        ? 'font-semibold text-slate-700'
                        : 'text-slate-500 italic'
                    "
                  >
                    {{ sale.customers?.name || "Consumidor Final" }}
                  </span>
                </td>
                <td class="px-8 py-5 text-sm">
                  <span
                    class="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-600"
                  >
                    {{ paymentLabel(sale.payment_method) }}
                  </span>
                </td>
                <td class="px-8 py-5 text-center text-sm">
                  <span
                    class="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-500"
                  >
                    {{ sale.sale_items?.length || 0 }}
                  </span>
                </td>
                <td class="px-8 py-5 text-right text-sm font-bold text-emerald-600">
                  S/ {{ Number(sale.total || 0).toFixed(2) }}
                </td>
                <td class="px-8 py-5 text-center">
                  <button
                    class="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-gray-200 bg-white text-slate-500 shadow-sm transition-all hover:bg-gray-50 hover:text-indigo-600"
                    @click="openDetails(sale)"
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <circle cx="11" cy="11" r="8" />
                      <path d="m21 21-4.3-4.3" />
                    </svg>
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div
      v-if="activeTab === 'checkout'"
      class="grid min-h-0 flex-1 grid-cols-1 gap-6 lg:grid-cols-[1fr_380px]"
    >
      <section
        class="min-h-0 overflow-y-auto rounded-2xl border border-gray-100 bg-white p-5 shadow-sm sm:p-6"
      >
        <div class="mb-5 flex items-center justify-between gap-3">
          <div>
            <h3 class="text-lg font-bold text-slate-800">Pedidos Pendientes</h3>
            <p class="text-sm text-slate-500">
              {{ heldSalesCount }} pedidos por cobrar
            </p>
          </div>
          <span
            class="inline-flex rounded-full px-2.5 py-1 text-xs font-bold"
            :class="
              ordersInDbMode
                ? 'bg-emerald-50 text-emerald-600'
                : 'bg-amber-50 text-amber-600'
            "
          >
            {{ ordersInDbMode ? "Modo compartido" : "Modo local" }}
          </span>
        </div>

        <div
          v-if="heldSales.length"
          class="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2"
        >
          <article
            v-for="sale in heldSales"
            :key="sale.id"
            class="cursor-pointer rounded-2xl border p-4 transition-all"
            :class="
              selectedHeldSaleId === sale.id
                ? 'border-indigo-200 bg-indigo-50 ring-2 ring-indigo-500/20'
                : 'border-gray-100 bg-white hover:-translate-y-1 hover:border-indigo-100 hover:shadow-lg'
            "
            @click="selectHeldSale(sale.id)"
          >
            <div class="mb-2 flex items-start justify-between gap-3">
              <p class="line-clamp-1 text-sm font-bold text-slate-800">
                {{ sale.name }}
              </p>
              <span class="text-sm font-bold text-indigo-600">
                {{ formatOrderMoney(heldSaleTotal(sale)) }}
              </span>
            </div>
            <p class="mb-1 text-xs text-slate-500">
              {{ customerNameById(sale.customer_id) }}
            </p>
            <p class="mb-3 text-xs text-slate-400">
              {{ new Date(sale.updated_at).toLocaleString("es-PE") }}
            </p>
            <div class="grid grid-cols-2 gap-2">
              <button
                class="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-600 transition-all hover:bg-gray-50"
                @click.stop="editHeldSale(sale.id)"
              >
                Editar
              </button>
              <button
                class="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-600 transition-all hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600"
                @click.stop="removeHeldSale(sale.id)"
              >
                Eliminar
              </button>
            </div>
          </article>
        </div>
        <div
          v-else
          class="rounded-2xl border-2 border-dashed border-gray-200 bg-white px-4 py-10 text-center text-sm text-slate-500"
        >
          <p>No hay pedidos pendientes.</p>
          <button
            class="mt-2 text-sm font-bold text-indigo-600 hover:text-indigo-700"
            @click="activeTab = 'pos'"
          >
            Crear nuevo pedido
          </button>
        </div>
      </section>

      <aside
        class="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-lg"
      >
        <template v-if="selectedHeldSale">
          <div class="border-b border-gray-100 p-6">
            <h3 class="text-lg font-bold text-slate-800">Ticket del Pedido</h3>
            <p class="mt-1 text-xs font-bold uppercase text-slate-400">
              {{ selectedHeldSale.name }}
            </p>
          </div>

          <div class="flex-1 space-y-3 overflow-y-auto p-4">
            <article
              v-for="(item, index) in selectedHeldSale.items"
              :key="`${item.product_id}-${index}`"
              class="flex items-center justify-between rounded-xl border border-transparent p-3 transition-all hover:border-gray-100 hover:bg-slate-50"
            >
              <div class="min-w-0">
                <p class="truncate text-sm font-bold text-slate-800">
                  {{ item.name }}
                </p>
                <p class="text-xs text-slate-500">
                  {{ Number(item.qty).toFixed(2) }} x
                  {{ formatOrderMoney(item.price_unit) }}
                </p>
              </div>
              <p class="text-sm font-bold text-slate-900">
                {{
                  formatOrderMoney(Number(item.qty || 0) * Number(item.price_unit || 0))
                }}
              </p>
            </article>
          </div>

          <div class="space-y-4 border-t border-gray-100 bg-slate-50 p-6">
            <div>
              <label class="mb-1.5 block text-xs font-bold text-slate-400"
                >Metodo de pago</label
              >
              <select v-model="checkoutPaymentMethod" class="ui-select">
                <option
                  v-for="method in paymentMethods"
                  :key="method.code"
                  :value="method.code"
                >
                  {{ method.label }}
                </option>
              </select>
            </div>

            <div class="flex items-center justify-between text-xl font-bold text-slate-900">
              <span>Total</span>
              <span>{{ formatOrderMoney(heldSaleTotal(selectedHeldSale)) }}</span>
            </div>

            <p
              v-if="checkoutMessage"
              class="rounded-xl border px-3 py-2 text-center text-sm font-medium"
              :class="
                checkoutMessageIsError
                  ? 'border-rose-200 bg-rose-50 text-rose-600'
                  : 'border-emerald-200 bg-emerald-50 text-emerald-600'
              "
            >
              {{ checkoutMessage }}
            </p>

            <div class="grid grid-cols-1 gap-2">
              <button
                class="rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm font-bold text-slate-600 shadow-sm transition-all hover:bg-gray-50"
                @click="editSelectedHeldSale"
              >
                Editar en TPV
              </button>
              <button
                class="rounded-xl bg-indigo-600 px-4 py-3 text-sm font-bold text-white shadow-lg shadow-indigo-500/30 transition-all hover:bg-indigo-700 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                :disabled="checkoutLoading"
                @click="chargeSelectedHeldSale"
              >
                {{ checkoutLoading ? "Procesando..." : "Confirmar Cobro" }}
              </button>
            </div>
          </div>
        </template>

        <template v-else>
          <div
            class="flex h-full items-center justify-center p-6 text-center text-sm text-slate-500"
          >
            Selecciona un pedido para ver su ticket y confirmar el cobro.
          </div>
        </template>
      </aside>
    </div>

    <div
      v-if="activeTab === 'reports'"
      class="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto"
    >
      <section class="grid grid-cols-1 gap-4 md:grid-cols-3">
        <article class="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
          <p class="text-xs font-bold uppercase tracking-widest text-slate-400">
            Ventas registradas
          </p>
          <p class="mt-1 text-3xl font-bold text-slate-800">
            {{ totalSalesCount }}
          </p>
        </article>
        <article class="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
          <p class="text-xs font-bold uppercase tracking-widest text-slate-400">
            Ingreso total
          </p>
          <p class="mt-1 text-3xl font-bold text-emerald-600">
            S/ {{ totalRevenue.toFixed(2) }}
          </p>
        </article>
        <article class="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
          <p class="text-xs font-bold uppercase tracking-widest text-slate-400">
            Ticket promedio
          </p>
          <p class="mt-1 text-3xl font-bold text-indigo-600">
            S/ {{ averageTicket.toFixed(2) }}
          </p>
        </article>
      </section>

      <section class="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div class="overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-sm">
          <div class="border-b border-gray-100 p-5">
            <h3 class="text-lg font-bold text-slate-800">Ventas por metodo</h3>
            <p class="text-sm text-slate-500">Distribucion por forma de pago</p>
          </div>
          <div class="p-4">
            <div
              v-if="paymentBreakdown.length"
              class="divide-y divide-gray-50 rounded-xl border border-gray-100"
            >
              <article
                v-for="row in paymentBreakdown"
                :key="row.code"
                class="flex items-center justify-between px-4 py-3"
              >
                <div>
                  <p class="text-sm font-bold text-slate-800">{{ row.label }}</p>
                  <p class="text-xs text-slate-500">{{ row.count }} ventas</p>
                </div>
                <p class="text-sm font-bold text-emerald-600">
                  S/ {{ row.total.toFixed(2) }}
                </p>
              </article>
            </div>
            <div
              v-else
              class="rounded-xl border-2 border-dashed border-gray-200 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500"
            >
              Sin datos de ventas para reportar.
            </div>
          </div>
        </div>

        <div class="overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-sm">
          <div class="border-b border-gray-100 p-5">
            <h3 class="text-lg font-bold text-slate-800">Top productos</h3>
            <p class="text-sm text-slate-500">Productos con mayor facturacion</p>
          </div>
          <div class="p-4">
            <div
              v-if="topProductsReport.length"
              class="divide-y divide-gray-50 rounded-xl border border-gray-100"
            >
              <article
                v-for="product in topProductsReport"
                :key="product.name"
                class="flex items-center justify-between gap-3 px-4 py-3"
              >
                <div class="min-w-0">
                  <p class="truncate text-sm font-bold text-slate-800">
                    {{ product.name }}
                  </p>
                  <p class="text-xs text-slate-500">
                    {{ product.qty.toFixed(2) }} unidades
                  </p>
                </div>
                <p class="shrink-0 text-sm font-bold text-indigo-600">
                  S/ {{ product.total.toFixed(2) }}
                </p>
              </article>
            </div>
            <div
              v-else
              class="rounded-xl border-2 border-dashed border-gray-200 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500"
            >
              Aun no hay productos en el reporte.
            </div>
          </div>
        </div>
      </section>
    </div>

    <Teleport to="body">
      <div
        v-if="showDetails"
        class="fixed inset-0 z-[1000] flex items-center justify-center p-3 sm:p-4"
      >
        <div
          class="absolute inset-0 bg-slate-900/55 backdrop-blur-md"
          @click="closeDetails"
        ></div>

        <div
          class="relative flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
        >
        <div
          class="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-3 sm:px-6 sm:py-4"
        >
          <div>
            <h3 class="text-lg font-bold text-slate-800">Detalle de Venta</h3>
            <p class="flex gap-2 text-sm text-slate-400">
              <span>{{
                new Date(selectedSale?.created_at).toLocaleString("es-PE", {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })
              }}</span>
            </p>
          </div>
          <button
            class="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-800"
            @click="closeDetails"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>

        <div class="flex-1 overflow-y-auto p-0">
          <div
            class="grid grid-cols-1 gap-4 border-b border-slate-200 bg-slate-50 px-4 py-4 text-sm sm:grid-cols-2 sm:px-6"
          >
            <div>
              <span
                class="mb-1 block text-xs font-semibold uppercase text-slate-500"
                >Cliente</span
              >
              <span class="text-slate-700">{{
                selectedSale?.customers?.name || "Consumidor Final"
              }}</span>
            </div>
            <div>
              <span
                class="mb-1 block text-xs font-semibold uppercase text-slate-500"
                >Pago</span
              >
              <span class="text-slate-700">{{
                paymentLabel(selectedSale?.payment_method || "efectivo")
              }}</span>
            </div>
          </div>

          <div class="overflow-x-auto">
            <table class="w-full min-w-[620px] text-left text-sm text-slate-600">
              <thead
                class="sticky top-0 border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500"
              >
                <tr>
                  <th class="px-4 py-3 font-semibold sm:px-6">Producto</th>
                  <th class="px-4 py-3 text-right font-semibold sm:px-6">
                    Cant.
                  </th>
                  <th class="px-4 py-3 text-right font-semibold sm:px-6">
                    Precio
                  </th>
                  <th class="px-4 py-3 text-right font-semibold sm:px-6">
                    Total
                  </th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-200">
                <tr
                  v-for="item in selectedSale?.sale_items"
                  :key="item.id"
                  class="hover:bg-indigo-50/30"
                >
                  <td class="px-4 py-3 font-medium text-slate-700 sm:px-6">
                    {{ item.products?.name || "Producto Desconocido" }}
                    <span class="block font-mono text-xs text-slate-500">{{
                      item.products?.sku
                    }}</span>
                  </td>
                  <td class="px-4 py-3 text-right font-mono sm:px-6">
                    {{ formatHistoryQty(item) }} {{ formatHistoryUnit(item) }}
                  </td>
                  <td
                    class="px-4 py-3 text-right font-mono text-slate-400 sm:px-6"
                  >
                    S/ {{ formatHistoryPrice(item) }}
                  </td>
                  <td
                    class="px-4 py-3 text-right font-semibold text-emerald-600 sm:px-6"
                  >
                    S/ {{ Number(item.total).toFixed(2) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div
          class="flex flex-col gap-2 border-t border-slate-200 bg-slate-50 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6"
        >
          <div class="font-mono text-xs text-slate-500">
            ID: {{ selectedSale?.id.slice(0, 8) }}...
          </div>
          <div class="w-full text-left sm:w-auto sm:text-right">
            <span class="mr-3 text-sm text-slate-400">Total Venta:</span>
            <span class="text-xl font-bold text-indigo-600">
              S/ {{ Number(selectedSale?.total || 0).toFixed(2) }}
            </span>
          </div>
        </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
