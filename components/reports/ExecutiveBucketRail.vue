<script setup lang="ts">
import type { PropType } from 'vue'

type BucketLike = {
  key: string
  label: string
  sales_total: number
  sales_cogs_total: number
  adjustments_cogs_total: number
  gross_profit_total: number
  balance_total: number
  margin_pct: number
}

const props = defineProps({
  title: {
    type: String,
    required: true
  },
  subtitle: {
    type: String,
    default: ''
  },
  buckets: {
    type: Array as PropType<BucketLike[]>,
    default: () => []
  },
  formatMoney: {
    type: Function as PropType<(value: number) => string>,
    required: true
  },
  formatPercent: {
    type: Function as PropType<(value: number) => string>,
    required: true
  },
  getCostTotal: {
    type: Function as PropType<(bucket: BucketLike) => number>,
    required: true
  },
  emptyState: {
    type: String,
    default: 'No hay registros para mostrar.'
  }
})

const hasData = computed(() => props.buckets.length > 0)
</script>

<template>
  <section class="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
    <div class="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h3 class="text-lg font-bold text-slate-800">{{ title }}</h3>
        <p v-if="subtitle" class="text-sm font-medium text-slate-500">{{ subtitle }}</p>
      </div>
      <p class="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">
        {{ buckets.length }} periodos
      </p>
    </div>

    <div
      v-if="!hasData"
      class="mt-5 rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-10 text-center text-sm font-medium text-slate-400"
    >
      {{ emptyState }}
    </div>

    <div v-else class="mt-5 overflow-x-auto pb-1">
      <div class="flex min-w-max gap-3">
        <article
          v-for="bucket in buckets"
          :key="bucket.key"
          class="w-[240px] shrink-0 rounded-2xl border border-slate-200 bg-slate-50 p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
        >
          <div class="flex items-start justify-between gap-3">
            <div>
              <p class="text-sm font-extrabold text-slate-800">{{ bucket.label }}</p>
              <p class="mt-1 text-[11px] font-bold uppercase tracking-widest text-slate-400">
                {{ bucket.gross_profit_total >= 0 ? 'Resultado positivo' : 'Resultado en alerta' }}
              </p>
            </div>
            <span
              class="rounded-full px-2.5 py-1 text-[11px] font-bold"
              :class="bucket.gross_profit_total >= 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'"
            >
              {{ formatPercent(bucket.margin_pct) }}
            </span>
          </div>

          <div class="mt-4 space-y-3">
            <div class="flex items-center justify-between gap-3 text-sm">
              <span class="text-slate-500">Ventas</span>
              <span class="font-bold text-slate-800">{{ formatMoney(bucket.sales_total) }}</span>
            </div>
            <div class="flex items-center justify-between gap-3 text-sm">
              <span class="text-slate-500">Costo</span>
              <span class="font-bold text-rose-600">{{ formatMoney(getCostTotal(bucket)) }}</span>
            </div>
            <div class="flex items-center justify-between gap-3 text-sm">
              <span class="text-slate-500">Ganancia</span>
              <span class="font-bold" :class="bucket.gross_profit_total >= 0 ? 'text-emerald-600' : 'text-rose-600'">
                {{ formatMoney(bucket.gross_profit_total) }}
              </span>
            </div>
            <div class="flex items-center justify-between gap-3 text-sm">
              <span class="text-slate-500">Balance</span>
              <span class="font-bold text-slate-800">{{ formatMoney(bucket.balance_total) }}</span>
            </div>
          </div>
        </article>
      </div>
    </div>
  </section>
</template>
