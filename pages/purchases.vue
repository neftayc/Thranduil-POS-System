<script setup lang="ts">
const suppliers = ref<any[]>([]);
const products = ref<any[]>([]);
const uomCatalog = ref<Array<{ code: string; label: string }>>([]);
const productUoms = ref<Record<string, Array<{ unit_name: string; factor_to_base: number }>>>({});
const history = ref<any[]>([]);
const message = ref("");
const loading = ref(false);
const showRegisterModal = ref(false);

const supplierId = ref<string | null>(null);
const invoiceNo = ref("");
const makeLine = () => ({ product_id: "", qty: 1, unit_name: "", factor_to_base: 1, cost_unit: 0 });
const items = ref<any[]>([makeLine()]);

// Modal state
const showDetails = ref(false);
const selectedPurchase = ref<any>(null);

const loadData = async () => {
  message.value = "";
  try {
    const data = await $fetch<{
      uomCatalog: Array<{ code: string; label: string }>;
      suppliers: any[];
      products: any[];
      conversions: any[];
      history: any[];
    }>("/api/purchases/page");

    uomCatalog.value = data.uomCatalog || [{ code: "unidad", label: "Unidad" }];
    if (!uomCatalog.value.some((item) => String(item.code || "").toLowerCase() === "unidad")) {
      uomCatalog.value.unshift({ code: "unidad", label: "Unidad" });
    }

    suppliers.value = data.suppliers || [];
    products.value = data.products || [];

    const uomData = Array.isArray(data.conversions) ? data.conversions : [];

  const map: Record<string, Array<{ unit_name: string; factor_to_base: number }>> = {};
  for (const product of products.value) {
    map[product.id] = [
      { unit_name: String(product.unit || "unidad").toLowerCase(), factor_to_base: 1 },
    ];
  }

  for (const row of uomData || []) {
    const productId = row.product_id;
    const unitName = String(row.unit_name || "").toLowerCase().trim();
    const factor = Number(row.factor_to_base || 0);
    if (!productId || !unitName || factor <= 0) continue;
    if (!map[productId]) map[productId] = [];
    if (map[productId].some((opt) => opt.unit_name === unitName)) continue;
    map[productId].push({ unit_name: unitName, factor_to_base: factor });
  }

  productUoms.value = map;

    history.value = data.history || [];
  } catch (err: any) {
    message.value = err?.data?.statusMessage || err?.message || "No se pudo cargar compras.";
  }
};

const addLine = () => {
  items.value.push(makeLine());
};

const removeLine = (index: number) => {
  items.value.splice(index, 1);
  if (!items.value.length) addLine();
};

const getProduct = (productId: string) =>
  products.value.find((p) => p.id === productId);

const normalizeUnitName = (value: string) => String(value || "").toLowerCase().trim();

const getUnitLabel = (unitName: string) => {
  const code = normalizeUnitName(unitName);
  const found = uomCatalog.value.find((item) => normalizeUnitName(item.code) === code);
  if (found) return found.label;
  return code ? code.charAt(0).toUpperCase() + code.slice(1) : "Unidad";
};

const getUomOptions = (productId: string) => {
  const configured = productUoms.value[productId] || [];
  const factors = new Map<string, number>();
  configured.forEach((row) => {
    factors.set(normalizeUnitName(row.unit_name), Number(row.factor_to_base || 0));
  });

  const options = (uomCatalog.value || []).map((row) => {
    const code = normalizeUnitName(row.code);
    const factor = Number(factors.get(code) || 0);
    return {
      unit_name: code,
      label: row.label,
      factor_to_base: factor,
      configured: factor > 0,
    };
  });

  configured.forEach((row) => {
    const code = normalizeUnitName(row.unit_name);
    if (!options.some((opt) => opt.unit_name === code)) {
      options.push({
        unit_name: code,
        label: getUnitLabel(code),
        factor_to_base: Number(row.factor_to_base || 0),
        configured: Number(row.factor_to_base || 0) > 0,
      });
    }
  });

  return options;
};

const getFactor = (productId: string, unitName: string) => {
  const selected = normalizeUnitName(unitName);
  const option = getUomOptions(productId).find((item) => item.unit_name === selected);
  return Number(option?.factor_to_base || 0);
};

const onSelectProduct = (item: any) => {
  const product = getProduct(item.product_id);
  if (!product) return;

  const options = getUomOptions(product.id);
  const selected = normalizeUnitName(item.unit_name);
  const exists = options.some((opt) => opt.unit_name === selected);
  const defaultOption = options.find((opt) => opt.configured) || options[0];
  item.unit_name = exists
    ? selected
    : String(defaultOption?.unit_name || product.unit || "unidad").toLowerCase();

  item.factor_to_base = getFactor(product.id, item.unit_name);
  if (item.factor_to_base <= 0) {
    message.value = `Configura el factor de "${getUnitLabel(item.unit_name)}" para ${product.name} en Productos.`;
  } else {
    message.value = "";
  }

  if (Number(item.cost_unit || 0) === 0) {
    const factor = Number(item.factor_to_base || 1);
    item.cost_unit = Number((Number(product.avg_cost || 0) * factor).toFixed(4));
  }
};

const onChangeUnit = (item: any) => {
  const product = getProduct(item.product_id);
  if (!product) return;

  const previousFactor = Number(item.factor_to_base || 1);
  const nextFactor = getFactor(product.id, item.unit_name);

  if (nextFactor <= 0) {
    item.factor_to_base = 0;
    message.value = `La unidad "${getUnitLabel(item.unit_name)}" no tiene factor para ${product.name}.`;
    return;
  }

  const baseCost =
    previousFactor > 0
      ? Number(item.cost_unit || 0) / previousFactor
      : Number(product.avg_cost || 0);

  item.factor_to_base = nextFactor;
  item.cost_unit = Number((baseCost * nextFactor).toFixed(4));
  message.value = "";
};

const formatUnitLabel = (value: string) => {
  return getUnitLabel(value);
};

const formatHistoryQty = (item: any) => {
  const value = item.qty_uom ?? item.qty ?? 0;
  return Number(value).toFixed(2);
};

const formatHistoryUnit = (item: any) =>
  formatUnitLabel(item.unit_name || item.products?.unit || "unidad");

const formatHistoryCost = (item: any) => {
  const value = item.cost_unit_uom ?? item.cost_unit ?? 0;
  return Number(value).toFixed(4);
};

const total = computed(() =>
  items.value.reduce(
    (sum, item) => sum + Number(item.qty || 0) * Number(item.cost_unit || 0),
    0,
  ),
);

const submitPurchase = async () => {
  message.value = "";
  loading.value = true;
  try {
    const cleaned = items.value
      .filter((item) => item.product_id && Number(item.qty) > 0)
      .map((item) => ({
        product_id: item.product_id,
        qty: Number(item.qty),
        unit_name: normalizeUnitName(item.unit_name),
        cost_unit: Number(item.cost_unit || 0),
      }));

    if (!cleaned.length) {
      message.value = "Agrega al menos un producto con cantidad válida.";
      return;
    }

    const missingFactor = cleaned.find(
      (item) => getFactor(item.product_id, item.unit_name) <= 0,
    );
    if (missingFactor) {
      const product = getProduct(missingFactor.product_id);
      message.value = `Configura factor para "${getUnitLabel(missingFactor.unit_name)}" en ${product?.name || "el producto"}.`;
      return;
    }

    await $fetch("/api/purchases/create", {
      method: "POST",
      body: {
        supplier_id: supplierId.value,
        invoice_no: invoiceNo.value || null,
        items: cleaned,
      },
    });

    message.value = "Compra registrada correctamente.";
    invoiceNo.value = "";
    supplierId.value = null;
    items.value = [makeLine()];
    showRegisterModal.value = false;
    await loadData();
  } catch (err: any) {
    message.value = err?.data?.statusMessage || err?.message || "No se pudo registrar la compra.";
  } finally {
    loading.value = false;
  }
};

const openRegisterModal = () => {
  message.value = "";
  showRegisterModal.value = true;
};

const closeRegisterModal = () => {
  if (loading.value) return;
  showRegisterModal.value = false;
};

const openDetails = (purchase: any) => {
  selectedPurchase.value = purchase;
  showDetails.value = true;
};

const closeDetails = () => {
  showDetails.value = false;
  selectedPurchase.value = null;
};

onMounted(loadData);
</script>

<template>
  <div class="space-y-8 pb-10">
    <!-- History Section -->
    <section class="ui-card">
      <div class="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 class="ui-heading">Historial de Compras</h2>
          <p class="ui-subtitle">Registro de movimientos y facturación</p>
        </div>
        <div class="flex items-center gap-2">
          <div class="ui-meta-chip w-fit">
            Últimos 50 registros
          </div>
          <button class="ui-btn" @click="openRegisterModal">Nueva compra</button>
        </div>
      </div>

      <div
        v-if="message"
        class="mb-4"
        :class="message.toLowerCase().includes('no se') || message.toLowerCase().includes('error') ? 'ui-alert-error' : 'ui-alert'"
      >
        {{ message }}
      </div>

      <div class="ui-table-wrap">
        <table class="ui-table">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Proveedor</th>
              <th>Documento</th>
              <th>Items</th>
              <th class="text-right">Total</th>
              <th class="text-center">Detalles</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in history" :key="row.id" class="group">
              <td class="font-medium text-slate-700">
                {{
                  new Date(row.created_at).toLocaleDateString("es-ES", {
                    day: "2-digit",
                    month: "short",
                    year: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })
                }}
              </td>
              <td>
                <div class="flex items-center gap-2">
                  <div
                    class="h-6 w-6 rounded-full bg-indigo-100 flex items-center justify-center text-[10px] font-bold text-indigo-700 border border-indigo-200"
                  >
                    {{ (row.suppliers?.name || "V")[0].toUpperCase() }}
                  </div>
                  <span class="text-slate-600">{{
                    row.suppliers?.name || "Varios / Sin nombre"
                  }}</span>
                </div>
              </td>
              <td>
                <span
                  v-if="row.invoice_no"
                  class="inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-1 font-mono text-xs text-slate-600 border border-slate-200"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path
                      d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"
                    />
                    <polyline points="14 2 14 8 20 8" />
                    <line x1="16" x2="8" y1="13" y2="13" />
                    <line x1="16" x2="8" y1="17" y2="17" />
                    <polyline points="10 9 9 9 8 9" />
                  </svg>
                  {{ row.invoice_no }}
                </span>
                <span v-else class="text-slate-600 text-xs italic">S/N</span>
              </td>
              <td>
                <span
                  class="rounded-full bg-white px-2.5 py-0.5 text-xs text-slate-500 font-medium border border-slate-200"
                >
                  {{ row.purchase_items?.length || 0 }} productos
                </span>
              </td>
              <td class="text-right font-display font-bold text-emerald-600">
                S/ {{ Number(row.total_cost || 0).toFixed(2) }}
              </td>
              <td class="text-center">
                <button
                  class="ui-btn-secondary h-8 w-8 !p-0 rounded-full hover:bg-indigo-100 hover:text-indigo-700 hover:border-indigo-300 transition-all active:scale-95"
                  @click="openDetails(row)"
                  title="Ver detalles"
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
                    <circle cx="12" cy="12" r="1" />
                    <circle cx="12" cy="5" r="1" />
                    <circle cx="12" cy="19" r="1" />
                  </svg>
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p v-if="!history.length" class="ui-empty-state mt-8">
        No hay registros de compras recientes.
      </p>
    </section>

    <Teleport to="body">
      <div
        v-if="showRegisterModal"
        class="fixed inset-0 z-[1000] flex items-center justify-center p-4"
      >
        <button
          class="absolute inset-0 bg-slate-900/55 backdrop-blur-sm"
          aria-label="Cerrar modal"
          @click="closeRegisterModal"
        />

        <section class="relative max-h-[92vh] w-full max-w-6xl overflow-y-auto rounded-2xl border border-gray-200 bg-white p-6 shadow-2xl sm:p-7">
        <div class="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 class="ui-heading text-2xl">Registrar Compra</h2>
            <p class="ui-subtitle">
              Ingresa los productos adquiridos para actualizar el stock e
              inventario.
            </p>
          </div>
          <div class="text-left sm:text-right">
            <div class="text-sm font-bold uppercase tracking-wider text-slate-400">
              Total Estimado
            </div>
            <div class="text-2xl font-bold text-indigo-600 sm:text-3xl">
              S/ {{ total.toFixed(2) }}
            </div>
          </div>
        </div>

        <div class="mt-8 grid gap-6 sm:grid-cols-2">
          <div class="space-y-2">
            <label class="ui-label">Proveedor</label>
            <div class="relative">
              <select v-model="supplierId" class="ui-select w-full pl-4">
                <option :value="null">Sin proveedor (Varios)</option>
                <option
                  v-for="supplier in suppliers"
                  :key="supplier.id"
                  :value="supplier.id"
                >
                  {{ supplier.name }}
                </option>
              </select>
            </div>
          </div>

          <div class="space-y-2">
            <label class="ui-label">N° Factura / Guía</label>
            <input
              v-model="invoiceNo"
              type="text"
              class="ui-input"
              placeholder="Ej: F001-00045"
            />
          </div>
        </div>

        <div class="ui-table-wrap mt-8">
          <table class="ui-table">
            <thead>
              <tr>
                <th class="w-1/3">Producto</th>
                <th class="w-32">Cantidad</th>
                <th class="w-36">Unidad</th>
                <th class="w-32">Costo Un.</th>
                <th class="w-32 text-right">Total</th>
                <th class="w-20 text-center">x</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(item, index) in items" :key="index">
                <td>
                  <select
                    v-model="item.product_id"
                    class="ui-select w-full"
                    @change="onSelectProduct(item)"
                  >
                    <option value="">Buscar producto...</option>
                    <option
                      v-for="product in products"
                      :key="product.id"
                      :value="product.id"
                    >
                      {{ product.name }}
                    </option>
                  </select>
                </td>
                <td>
                  <input
                    v-model.number="item.qty"
                    class="ui-input w-full px-3 py-1 text-center font-mono"
                    type="number"
                    step="0.01"
                    min="0"
                  />
                </td>
                <td>
                  <select
                    v-model="item.unit_name"
                    class="ui-select w-full"
                    :disabled="!item.product_id"
                    @change="onChangeUnit(item)"
                  >
                    <option value="">Seleccionar</option>
                    <option
                      v-for="option in getUomOptions(item.product_id)"
                      :key="`${item.product_id}-${option.unit_name}`"
                      :value="option.unit_name"
                    >
                      {{ option.label }}{{ option.configured ? "" : " (sin factor)" }}
                    </option>
                  </select>
                </td>
                <td>
                  <div class="relative">
                    <span class="absolute left-3 top-1.5 text-slate-500 text-xs"
                      >S/</span
                    >
                    <input
                      v-model.number="item.cost_unit"
                      class="ui-input w-full pl-8 pr-3 py-1 text-right font-mono"
                      type="number"
                      step="0.0001"
                      min="0"
                    />
                  </div>
                </td>
                <td class="text-right font-mono font-semibold text-indigo-600">
                  S/
                  {{
                    (
                      Number(item.qty || 0) * Number(item.cost_unit || 0)
                    ).toFixed(2)
                  }}
                </td>
                <td class="text-center">
                  <button
                    class="text-slate-500 hover:text-rose-600 transition-colors p-1"
                    @click="removeLine(index)"
                    title="Quitar línea"
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
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="mt-4 flex justify-center">
          <button class="ui-btn-secondary px-4 py-2" @click="addLine">
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
              <circle cx="12" cy="12" r="10" />
              <path d="M8 12h8" />
              <path d="M12 8v8" />
            </svg>
            Agregar línea
          </button>
        </div>

        <div
          class="mt-6 flex flex-col sm:flex-row items-center justify-end gap-4 border-t border-slate-200 pt-6"
        >
          <div
            v-if="message"
            class="flex-1"
            :class="message.toLowerCase().includes('no se') ? 'ui-alert-error' : 'ui-alert'"
          >
            {{ message }}
          </div>
          <button class="ui-btn-secondary w-full sm:w-auto" :disabled="loading" @click="closeRegisterModal">
            Cancelar
          </button>
          <button class="ui-btn w-full min-w-0 sm:w-auto sm:min-w-[200px]" :disabled="loading" @click="submitPurchase">
            <span v-if="loading" class="flex items-center gap-2">
              <svg
                class="animate-spin h-4 w-4 text-white"
                xmlns="http://www.w3.org/2000/svg"
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
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                ></path>
              </svg>
              Procesando...
            </span>
            <span v-else>Confirmar Compra</span>
          </button>
        </div>
        </section>
      </div>
    </Teleport>

    <!-- Details Modal -->
    <Teleport to="body">
      <div
        v-if="showDetails"
        class="fixed inset-0 z-[1000] flex items-center justify-center p-4"
      >
        <!-- Backdrop -->
        <div
          class="absolute inset-0 bg-slate-900/55 backdrop-blur-sm"
          @click="closeDetails"
        ></div>

        <!-- Modal Content -->
        <div
          class="relative w-full max-w-2xl rounded-2xl border border-slate-200 bg-white shadow-2xl overflow-hidden flex flex-col max-h-[90vh] animate-in fade-in zoom-in-95 duration-200"
        >
        <!-- Header -->
        <div
          class="flex items-center justify-between border-b border-slate-200 px-6 py-4 bg-slate-50"
        >
          <div>
            <h3 class="font-display text-lg text-slate-800">
              Detalles de Compra
            </h3>
            <p class="text-sm text-slate-400 flex gap-2">
              <span>{{
                new Date(selectedPurchase?.created_at).toLocaleDateString()
              }}</span>
              <span>·</span>
              <span class="text-indigo-600 font-medium">{{
                selectedPurchase?.invoice_no || "Sin Factura"
              }}</span>
            </p>
          </div>
          <button
            class="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-800 transition-colors"
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

        <!-- Body -->
        <div class="overflow-y-auto p-0 flex-1">
          <table class="w-full text-sm text-left text-slate-600">
            <thead
              class="bg-slate-50 text-xs uppercase text-slate-500 sticky top-0 border-b border-slate-200"
            >
              <tr>
                <th class="px-6 py-3 font-semibold">Producto</th>
                <th class="px-6 py-3 font-semibold text-right">Cant.</th>
                <th class="px-6 py-3 font-semibold text-right">Costo U.</th>
                <th class="px-6 py-3 font-semibold text-right">Total</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-200">
              <tr
                v-for="item in selectedPurchase?.purchase_items"
                :key="item.id"
                class="hover:bg-indigo-50/30"
              >
                <td class="px-6 py-3 font-medium text-slate-700">
                  {{ item.products?.name || "Producto Desconocido" }}
                </td>
                <td class="px-6 py-3 text-right font-mono">
                  {{ formatHistoryQty(item) }} {{ formatHistoryUnit(item) }}
                </td>
                <td class="px-6 py-3 text-right font-mono text-slate-400">
                  S/ {{ formatHistoryCost(item) }}
                </td>
                <td class="px-6 py-3 text-right font-semibold text-emerald-600">
                  S/ {{ Number(item.total_cost).toFixed(2) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Footer -->
        <div
          class="border-t border-slate-200 bg-slate-50 px-6 py-4 flex justify-between items-center"
        >
          <div class="text-xs text-slate-500 font-mono">
            ID: {{ selectedPurchase?.id.slice(0, 8) }}...
          </div>
          <div class="text-right">
            <span class="text-sm text-slate-400 mr-3">Total Compra:</span>
            <span class="text-xl font-bold text-indigo-600"
              >S/
              {{ Number(selectedPurchase?.total_cost || 0).toFixed(2) }}</span
            >
          </div>
        </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
