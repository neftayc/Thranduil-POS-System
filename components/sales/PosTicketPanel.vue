<script setup lang="ts">
type CartItem = {
  product_id: string;
  name: string;
  unit_name: string;
  qty: number;
  auto_price_unit: number;
  price_unit: number;
  pricing_source: string;
  manual_price_override: number | null;
};

type UomOption = {
  unit_name: string;
  factor_to_base: number;
};

const props = defineProps<{
  cart: CartItem[];
  total: number;
  ticketCode: string;
  message: string;
  messageIsError: boolean;
  loading: boolean;
  canUseManualDiscount: boolean;
  cartItemBrand: (item: CartItem) => string;
  getUomOptions: (productId: string) => UomOption[];
  formatUnitLabel: (value: string) => string;
  pricingSourceLabel: (value: string | null | undefined) => string;
  formatOrderMoney: (value: any) => string;
  decrementItemQty: (item: CartItem, index: number) => void | Promise<void>;
  incrementItemQty: (item: CartItem, index: number) => void | Promise<void>;
  onCartQtyChange: (item: CartItem, index?: number) => void | Promise<void>;
  onCartUnitChange: (item: CartItem, index: number) => void | Promise<void>;
  onManualUnitPriceChange: (item: CartItem) => void;
  removeFromCart: (index: number) => void;
  submitSale: () => void | Promise<unknown>;
}>();
</script>

<template>
  <aside
    class="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-lg"
  >
    <div class="border-b border-gray-100 bg-white p-6">
      <h3 class="text-lg font-bold text-slate-800">Ticket Actual</h3>
      <p class="mt-1 text-xs font-bold uppercase tracking-wide text-slate-400">
        {{ ticketCode }}
      </p>
    </div>

    <div class="flex-1 space-y-3 overflow-y-auto p-4">
      <article
        v-for="(item, index) in cart"
        :key="`${item.product_id}-${item.unit_name}-${index}`"
        class="flex items-start justify-between gap-3 rounded-xl border border-transparent p-3 transition-all hover:border-gray-100 hover:bg-slate-50"
      >
        <div class="flex min-w-0 flex-1 items-start gap-3">
          <div
            class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-lg text-indigo-600"
          >
            {{ ["📒", "🎒", "✏️", "🎨", "✂️", "🖊️", "📏", "🧴"][index % 8] }}
          </div>

          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-bold text-slate-800">
              {{ item.name }}
            </p>
            <p class="mt-0.5 truncate text-xs text-slate-500">
              <span v-if="cartItemBrand(item)" class="font-medium text-slate-400">
                {{ cartItemBrand(item) }}
              </span>
              <span v-if="cartItemBrand(item)" class="px-1 text-slate-300">·</span>
              <span>
                {{ Number(item.qty).toFixed(0) }} x
                {{ formatUnitLabel(item.unit_name) }}
              </span>
            </p>

            <div
              class="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-[8.25rem_9rem_6.75rem] sm:items-end"
            >
              <div class="w-full">
                <p
                  class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400"
                >
                  Cantidad
                </p>
                <div class="flex items-center gap-1">
                  <button
                    class="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100 text-sm font-bold text-slate-500 hover:bg-slate-200"
                    @click="decrementItemQty(item, index)"
                  >
                    -
                  </button>
                  <input
                    v-model.number="item.qty"
                    type="number"
                    min="1"
                    class="h-8 w-14 rounded-lg border border-gray-200 bg-white px-2 py-0.5 text-center text-sm font-semibold text-slate-700 focus:border-indigo-500 focus:outline-none"
                    @change="onCartQtyChange(item, index)"
                  />
                  <button
                    class="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100 text-sm font-bold text-slate-500 hover:bg-slate-200"
                    @click="incrementItemQty(item, index)"
                  >
                    +
                  </button>
                </div>
              </div>

              <label class="w-full sm:w-auto">
                <span
                  class="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-400"
                >
                  Unidad
                </span>
                <select
                  v-model="item.unit_name"
                  class="h-8 w-full rounded-lg border border-gray-200 bg-white px-2 text-sm font-semibold text-slate-700 focus:border-indigo-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
                  :disabled="getUomOptions(item.product_id).length <= 1"
                  @change="onCartUnitChange(item, index)"
                >
                  <option
                    v-for="option in getUomOptions(item.product_id)"
                    :key="option.unit_name"
                    :value="option.unit_name"
                  >
                    {{ formatUnitLabel(option.unit_name) }}
                  </option>
                </select>
              </label>

              <label class="w-full sm:w-auto">
                <span
                  class="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-400"
                >
                  Precio
                </span>
                <input
                  v-model.number="item.price_unit"
                  type="number"
                  min="0"
                  step="0.01"
                  class="h-8 w-full rounded-lg border px-2 text-right text-sm font-semibold focus:outline-none disabled:cursor-not-allowed"
                  :class="
                    canUseManualDiscount
                      ? 'border-emerald-300 bg-white text-emerald-700 focus:border-emerald-500'
                      : 'border-gray-200 bg-slate-100 text-slate-400 focus:border-gray-200'
                  "
                  :disabled="!canUseManualDiscount"
                  title="Solo owner y manager pueden cambiar el precio."
                  @change="onManualUnitPriceChange(item)"
                  @blur="onManualUnitPriceChange(item)"
                />
              </label>
            </div>

            <p
              class="mt-1 text-[11px] font-medium"
              :class="
                item.manual_price_override !== null && canUseManualDiscount
                  ? 'text-amber-600'
                  : 'text-slate-400'
              "
            >
              {{
                item.manual_price_override !== null && canUseManualDiscount
                  ? "Precio manual aplicado."
                  : `Tarifa: ${pricingSourceLabel(item.pricing_source)}`
              }}
            </p>
          </div>
        </div>

        <div class="shrink-0 pt-1 text-right">
          <p class="text-sm font-bold text-slate-900">
            {{
              formatOrderMoney(
                Number(item.qty || 0) * Number(item.price_unit || 0),
              )
            }}
          </p>
          <p class="mt-1 text-[11px] text-slate-400">
            Auto: {{ formatOrderMoney(item.auto_price_unit) }}
          </p>
          <button
            class="mt-3 block w-full text-right text-xs text-rose-500 hover:text-rose-600"
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
      <div
        class="flex items-center justify-between text-[2rem] font-black text-slate-900"
      >
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
</template>
