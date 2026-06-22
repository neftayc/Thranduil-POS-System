<script setup lang="ts">
definePageMeta({ middleware: ["owner"] });

type ProductProfitabilityPeriodCode =
  | "recovery_2025_to_2026_03_08"
  | "standard_from_2026_03_09";

type ProductProfitabilityPeriodFilter = "auto" | ProductProfitabilityPeriodCode;

type FinancialSummaryData = {
  generated_at: string;
  period_code: ProductProfitabilityPeriodCode;
  period_start: string;
  period_end: string | null;
  adjustments_counted_as_sales: boolean;
  purchase_items_count: number;
  sale_items_count: number;
  adjustment_items_count: number;
  purchases_total: number;
  sales_recorded_total: number;
  sales_from_adjustment_total: number;
  sales_total: number;
  sales_cogs_total: number;
  adjustments_cogs_total: number;
  gross_profit_total: number;
  balance_total: number;
  margin_pct: number;
  profit_ten_percent: number;
  net_after_profit_share: number;
};

const loading = ref(false);
const errorMessage = ref("");
const generatedAt = ref<string | null>(null);
const selectedPeriod = ref<ProductProfitabilityPeriodFilter>("auto");
const reportPeriodCode = ref<ProductProfitabilityPeriodCode | null>(null);
const reportPeriodStart = ref<string | null>(null);
const reportPeriodEnd = ref<string | null>(null);
const adjustmentsCountedAsSales = ref(false);

const summary = reactive<FinancialSummaryData>({
  generated_at: "",
  period_code: "standard_from_2026_03_09",
  period_start: "",
  period_end: null,
  adjustments_counted_as_sales: false,
  purchase_items_count: 0,
  sale_items_count: 0,
  adjustment_items_count: 0,
  purchases_total: 0,
  sales_recorded_total: 0,
  sales_from_adjustment_total: 0,
  sales_total: 0,
  sales_cogs_total: 0,
  adjustments_cogs_total: 0,
  gross_profit_total: 0,
  balance_total: 0,
  margin_pct: 0,
  profit_ten_percent: 0,
  net_after_profit_share: 0,
});

const moneyFormatter = new Intl.NumberFormat("es-PE", {
  style: "currency",
  currency: "PEN",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const numberFormatter = new Intl.NumberFormat("es-PE", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

const percentFormatter = new Intl.NumberFormat("es-PE", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

const formatMoney = (value: number) => moneyFormatter.format(Number(value || 0));
const formatCount = (value: number) => numberFormatter.format(Number(value || 0));
const formatPercent = (value: number) =>
  `${percentFormatter.format(Number(value || 0))}%`;

const formatIsoDate = (value: string | null) => {
  if (!value) return "";
  const parts = value.split("-");
  if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
  return value;
};

const generatedAtLabel = computed(() => {
  if (!generatedAt.value) return "";

  const date = new Date(generatedAt.value);
  if (Number.isNaN(date.getTime())) return "";

  return new Intl.DateTimeFormat("es-PE", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
});

const periodRangeLabel = computed(() => {
  if (!reportPeriodStart.value) return "";
  if (!reportPeriodEnd.value) return `Desde ${formatIsoDate(reportPeriodStart.value)}`;
  return `${formatIsoDate(reportPeriodStart.value)} al ${formatIsoDate(reportPeriodEnd.value)}`;
});

const periodModeLabel = computed(() =>
  adjustmentsCountedAsSales.value
    ? "Modo recuperacion: las ventas incluyen ventas registradas y ajustes negativos de inventario."
    : "Modo normal: las ventas incluyen solo ventas registradas."
);

const periodCodeLabel = computed(() => {
  if (reportPeriodCode.value === "recovery_2025_to_2026_03_08") {
    return "Recuperacion 2025-2026";
  }
  if (reportPeriodCode.value === "standard_from_2026_03_09") {
    return "Operacion normal";
  }
  return "";
});

const balanceTone = computed(() =>
  summary.balance_total >= 0 ? "text-emerald-600" : "text-rose-600",
);

const profitTone = computed(() =>
  summary.gross_profit_total >= 0 ? "text-emerald-600" : "text-rose-600",
);

const tenPercentTone = computed(() =>
  summary.profit_ten_percent >= 0 ? "text-indigo-600" : "text-rose-600",
);

const loadSummary = async () => {
  loading.value = true;
  errorMessage.value = "";

  try {
    const data = await $fetch<FinancialSummaryData>(
      "/api/reports/financial-summary",
      {
        query:
          selectedPeriod.value === "auto"
            ? undefined
            : { period: selectedPeriod.value },
      },
    );

    generatedAt.value = data.generated_at || null;
    reportPeriodCode.value = data.period_code || null;
    reportPeriodStart.value = data.period_start || null;
    reportPeriodEnd.value = data.period_end || null;
    adjustmentsCountedAsSales.value = data.adjustments_counted_as_sales === true;

    summary.generated_at = data.generated_at || "";
    summary.period_code = data.period_code;
    summary.period_start = data.period_start;
    summary.period_end = data.period_end;
    summary.adjustments_counted_as_sales = data.adjustments_counted_as_sales === true;
    summary.purchase_items_count = Number(data.purchase_items_count || 0);
    summary.sale_items_count = Number(data.sale_items_count || 0);
    summary.adjustment_items_count = Number(data.adjustment_items_count || 0);
    summary.purchases_total = Number(data.purchases_total || 0);
    summary.sales_recorded_total = Number(data.sales_recorded_total || 0);
    summary.sales_from_adjustment_total = Number(data.sales_from_adjustment_total || 0);
    summary.sales_total = Number(data.sales_total || 0);
    summary.sales_cogs_total = Number(data.sales_cogs_total || 0);
    summary.adjustments_cogs_total = Number(data.adjustments_cogs_total || 0);
    summary.gross_profit_total = Number(data.gross_profit_total || 0);
    summary.balance_total = Number(data.balance_total || 0);
    summary.margin_pct = Number(data.margin_pct || 0);
    summary.profit_ten_percent = Number(data.profit_ten_percent || 0);
    summary.net_after_profit_share = Number(data.net_after_profit_share || 0);
  } catch (err: any) {
    errorMessage.value =
      err?.data?.statusMessage ||
      err?.message ||
      "No se pudo cargar el resumen financiero.";
  } finally {
    loading.value = false;
  }
};

onMounted(loadSummary);
</script>

<template>
  <div class="space-y-8">
    <section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div class="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 class="text-xl font-bold text-slate-800">Resumen financiero por periodo</h2>
          <p class="mt-1 text-sm text-slate-500">
            Usa el mismo periodo de rentabilidad por producto para revisar compras, ventas, balance, ganancia y su 10%.
          </p>
          <p
            class="mt-1 text-xs font-medium"
            :class="adjustmentsCountedAsSales ? 'text-indigo-600' : 'text-emerald-700'"
          >
            {{ periodModeLabel }}
          </p>
          <p
            v-if="periodCodeLabel || periodRangeLabel"
            class="mt-1 text-xs font-medium text-slate-500"
          >
            {{ periodCodeLabel }}<span v-if="periodCodeLabel && periodRangeLabel"> · </span>{{ periodRangeLabel }}
          </p>
          <p v-if="generatedAtLabel" class="mt-2 text-xs font-medium text-slate-400">
            Ultima actualizacion: {{ generatedAtLabel }}
          </p>
        </div>

        <div class="flex flex-wrap gap-2">
          <label class="min-w-[250px]">
            <span class="mb-1 block text-xs font-bold uppercase tracking-wide text-slate-400">Periodo</span>
            <select
              v-model="selectedPeriod"
              class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-100"
              :disabled="loading"
              @change="loadSummary"
            >
              <option value="auto">Periodo actual (automatico)</option>
              <option value="recovery_2025_to_2026_03_08">Recuperacion: 01/01/2025 - 08/03/2026</option>
              <option value="standard_from_2026_03_09">Normal: desde 09/03/2026</option>
            </select>
          </label>

          <NuxtLink to="/product-profitability" class="ui-btn-secondary">
            Ver rentabilidad
          </NuxtLink>

          <button
            class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
            type="button"
            :disabled="loading"
            @click="loadSummary"
          >
            {{ loading ? "Actualizando..." : "Actualizar resumen" }}
          </button>
        </div>
      </div>

      <div v-if="errorMessage" class="ui-alert-error mt-4">
        {{ errorMessage }}
      </div>
    </section>

    <section class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-5">
      <article class="card-hover rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <p class="text-xs font-bold uppercase tracking-wide text-slate-400">Compras del periodo</p>
        <p class="mt-2 text-3xl font-bold text-slate-800">
          {{ loading ? "..." : formatMoney(summary.purchases_total) }}
        </p>
        <p class="mt-1 text-xs font-medium text-slate-500">
          Lineas registradas: {{ loading ? "..." : formatCount(summary.purchase_items_count) }}
        </p>
      </article>

      <article class="card-hover rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <p class="text-xs font-bold uppercase tracking-wide text-slate-400">Ventas del periodo</p>
        <p class="mt-2 text-3xl font-bold text-slate-800">
          {{ loading ? "..." : formatMoney(summary.sales_total) }}
        </p>
        <p class="mt-1 text-xs font-medium text-slate-500">
          Registradas: {{ loading ? "..." : formatMoney(summary.sales_recorded_total) }} · Ajustes: {{ loading ? "..." : formatMoney(summary.sales_from_adjustment_total) }}
        </p>
      </article>

      <article class="card-hover rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <p class="text-xs font-bold uppercase tracking-wide text-slate-400">Balance del periodo</p>
        <p class="mt-2 text-3xl font-bold" :class="balanceTone">
          {{ loading ? "..." : formatMoney(summary.balance_total) }}
        </p>
        <p class="mt-1 text-xs font-medium text-slate-500">
          Formula: ventas - compras
        </p>
      </article>

      <article class="card-hover rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <p class="text-xs font-bold uppercase tracking-wide text-slate-400">Ganancia del periodo</p>
        <p class="mt-2 text-3xl font-bold" :class="profitTone">
          {{ loading ? "..." : formatMoney(summary.gross_profit_total) }}
        </p>
        <p class="mt-1 text-xs font-medium text-slate-500">
          Costos: {{ loading ? "..." : formatMoney(summary.sales_cogs_total + summary.adjustments_cogs_total) }}
        </p>
      </article>

      <article class="card-hover rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <p class="text-xs font-bold uppercase tracking-wide text-slate-400">10% de la ganancia</p>
        <p class="mt-2 text-3xl font-bold" :class="tenPercentTone">
          {{ loading ? "..." : formatMoney(summary.profit_ten_percent) }}
        </p>
        <p class="mt-1 text-xs font-medium text-slate-500">
          Neto despues del 10%: {{ loading ? "..." : formatMoney(summary.net_after_profit_share) }}
        </p>
      </article>
    </section>

    <section class="grid grid-cols-1 gap-6 xl:grid-cols-3">
      <article class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm xl:col-span-2">
        <div class="flex items-center justify-between gap-4">
          <div>
            <h3 class="text-lg font-bold text-slate-800">Como se calcula</h3>
            <p class="text-sm font-medium text-slate-500">
              Todas las cifras usan el mismo corte temporal que la pagina de rentabilidad.
            </p>
          </div>
          <span class="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-500">
            {{ periodRangeLabel || "Sin periodo" }}
          </span>
        </div>

        <div class="mt-6 overflow-hidden rounded-2xl border border-slate-100">
          <table class="min-w-full divide-y divide-slate-100 text-sm">
            <thead class="bg-slate-50">
              <tr class="text-left text-xs font-bold uppercase tracking-wide text-slate-400">
                <th class="px-4 py-3">Indicador</th>
                <th class="px-4 py-3">Formula</th>
                <th class="px-4 py-3 text-right">Valor</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100 bg-white text-slate-600">
              <tr>
                <td class="px-4 py-3 font-semibold text-slate-800">Compras del periodo</td>
                <td class="px-4 py-3">Suma de `purchase_items.total_cost` dentro del periodo</td>
                <td class="px-4 py-3 text-right font-semibold text-slate-800">
                  {{ loading ? "..." : formatMoney(summary.purchases_total) }}
                </td>
              </tr>
              <tr>
                <td class="px-4 py-3 font-semibold text-slate-800">Ventas registradas</td>
                <td class="px-4 py-3">Suma de `sale_items.total` dentro del periodo</td>
                <td class="px-4 py-3 text-right font-semibold text-slate-800">
                  {{ loading ? "..." : formatMoney(summary.sales_recorded_total) }}
                </td>
              </tr>
              <tr>
                <td class="px-4 py-3 font-semibold text-slate-800">Ventas por ajustes</td>
                <td class="px-4 py-3">Solo aplica en modo recuperacion</td>
                <td class="px-4 py-3 text-right font-semibold text-slate-800">
                  {{ loading ? "..." : formatMoney(summary.sales_from_adjustment_total) }}
                </td>
              </tr>
              <tr>
                <td class="px-4 py-3 font-semibold text-slate-800">Balance del periodo</td>
                <td class="px-4 py-3">Ventas totales - compras del periodo</td>
                <td class="px-4 py-3 text-right font-semibold" :class="balanceTone">
                  {{ loading ? "..." : formatMoney(summary.balance_total) }}
                </td>
              </tr>
              <tr>
                <td class="px-4 py-3 font-semibold text-slate-800">Costo de ventas</td>
                <td class="px-4 py-3">Costo real de salidas por venta en el periodo</td>
                <td class="px-4 py-3 text-right font-semibold text-slate-800">
                  {{ loading ? "..." : formatMoney(summary.sales_cogs_total) }}
                </td>
              </tr>
              <tr>
                <td class="px-4 py-3 font-semibold text-slate-800">Costo por ajustes</td>
                <td class="px-4 py-3">Costo estimado de ajustes negativos contados como venta</td>
                <td class="px-4 py-3 text-right font-semibold text-slate-800">
                  {{ loading ? "..." : formatMoney(summary.adjustments_cogs_total) }}
                </td>
              </tr>
              <tr>
                <td class="px-4 py-3 font-semibold text-slate-800">Ganancia del periodo</td>
                <td class="px-4 py-3">Ventas totales - costos del periodo</td>
                <td class="px-4 py-3 text-right font-semibold" :class="profitTone">
                  {{ loading ? "..." : formatMoney(summary.gross_profit_total) }}
                </td>
              </tr>
              <tr>
                <td class="px-4 py-3 font-semibold text-slate-800">10% de la ganancia</td>
                <td class="px-4 py-3">Ganancia del periodo x 0.10</td>
                <td class="px-4 py-3 text-right font-semibold" :class="tenPercentTone">
                  {{ loading ? "..." : formatMoney(summary.profit_ten_percent) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </article>

      <article class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h3 class="text-lg font-bold text-slate-800">Lectura rapida</h3>

        <div class="mt-5 space-y-4">
          <div class="rounded-2xl bg-slate-50 p-4">
            <p class="text-xs font-bold uppercase tracking-wide text-slate-400">Margen del periodo</p>
            <p class="mt-2 text-2xl font-bold text-slate-800">
              {{ loading ? "..." : formatPercent(summary.margin_pct) }}
            </p>
            <p class="mt-1 text-xs font-medium text-slate-500">
              Ganancia del periodo sobre ventas del periodo.
            </p>
          </div>

          <div class="rounded-2xl bg-slate-50 p-4">
            <p class="text-xs font-bold uppercase tracking-wide text-slate-400">Ventas registradas</p>
            <p class="mt-2 text-2xl font-bold text-slate-800">
              {{ loading ? "..." : formatCount(summary.sale_items_count) }}
            </p>
            <p class="mt-1 text-xs font-medium text-slate-500">
              Lineas de venta dentro del periodo.
            </p>
          </div>

          <div class="rounded-2xl bg-slate-50 p-4">
            <p class="text-xs font-bold uppercase tracking-wide text-slate-400">Ajustes contados</p>
            <p class="mt-2 text-2xl font-bold text-slate-800">
              {{ loading ? "..." : formatCount(summary.adjustment_items_count) }}
            </p>
            <p class="mt-1 text-xs font-medium text-slate-500">
              Solo suma cuando el periodo esta en modo recuperacion.
            </p>
          </div>

          <div
            class="rounded-2xl p-4"
            :class="adjustmentsCountedAsSales ? 'bg-indigo-50' : 'bg-emerald-50'"
          >
            <p
              class="text-sm font-semibold"
              :class="adjustmentsCountedAsSales ? 'text-indigo-900' : 'text-emerald-800'"
            >
              {{ adjustmentsCountedAsSales
                ? 'En este periodo los ajustes negativos tambien suman como ventas y ganancia estimada.'
                : 'En este periodo solo se consideran ventas registradas; los ajustes no se suman como ventas.' }}
            </p>
          </div>
        </div>
      </article>
    </section>
  </div>
</template>
