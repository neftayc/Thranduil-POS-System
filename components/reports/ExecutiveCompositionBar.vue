<script setup lang="ts">
import type { PropType } from 'vue'

const props = defineProps({
  salesTotal: {
    type: Number,
    required: true
  },
  cogsTotal: {
    type: Number,
    required: true
  },
  grossProfitTotal: {
    type: Number,
    required: true
  },
  marginPct: {
    type: Number,
    required: true
  },
  profitTenPercent: {
    type: Number,
    required: true
  },
  netAfterProfitShare: {
    type: Number,
    required: true
  },
  formatMoney: {
    type: Function as PropType<(value: number) => string>,
    required: true
  },
  formatPercent: {
    type: Function as PropType<(value: number) => string>,
    required: true
  }
})

const salesBase = computed(() => Math.max(props.salesTotal, 0))
const costPct = computed(() => {
  if (salesBase.value <= 0) return 0
  return Math.min(100, (props.cogsTotal / salesBase.value) * 100)
})

const profitPct = computed(() => {
  if (salesBase.value <= 0) return 0
  if (props.grossProfitTotal <= 0) return 0
  return Math.min(100 - costPct.value, (props.grossProfitTotal / salesBase.value) * 100)
})

const lossPct = computed(() => {
  if (salesBase.value <= 0) return 0
  if (props.grossProfitTotal >= 0) return 0
  return Math.min(Math.max(0, 100 - costPct.value), Math.abs(props.grossProfitTotal / salesBase.value) * 100)
})

const hasSales = computed(() => salesBase.value > 0)
</script>

<template>
  <section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
    <div class="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h3 class="text-lg font-bold text-slate-800">Composicion del total</h3>
        <p class="text-sm font-medium text-slate-500">
          Lectura ejecutiva de ventas, costo y utilidad bruta.
        </p>
      </div>
      <div class="text-xs font-semibold text-slate-500">
        Margen: {{ formatPercent(marginPct) }}
      </div>
    </div>

    <div v-if="!hasSales" class="mt-6 rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-10 text-center text-sm font-medium text-slate-400">
      No hay ventas para construir la composicion.
    </div>

    <div v-else class="mt-6 space-y-5">
      <div class="overflow-hidden rounded-full bg-slate-100">
        <div class="flex h-4 w-full">
          <div
            class="bg-rose-500"
            :style="{ width: `${costPct}%` }"
            :title="`Costo de ventas: ${formatMoney(cogsTotal)}`"
          />
          <div
            v-if="grossProfitTotal > 0"
            class="bg-emerald-500"
            :style="{ width: `${profitPct}%` }"
            :title="`Ganancia bruta: ${formatMoney(grossProfitTotal)}`"
          />
          <div
            v-else-if="grossProfitTotal < 0"
            class="bg-rose-700"
            :style="{ width: `${lossPct}%` }"
            :title="`Perdida: ${formatMoney(Math.abs(grossProfitTotal))}`"
          />
        </div>
      </div>

      <p v-if="grossProfitTotal < 0" class="text-xs font-medium text-rose-600">
        La ganancia bruta es negativa; el exceso sobre ventas no se fuerza en la barra para mantener la lectura clara.
      </p>

      <div class="grid gap-3 md:grid-cols-3">
        <div class="rounded-2xl bg-slate-50 p-4">
          <p class="text-xs font-bold uppercase tracking-wide text-slate-400">Ventas totales</p>
          <p class="mt-2 text-2xl font-bold text-slate-800">{{ formatMoney(salesTotal) }}</p>
        </div>
        <div class="rounded-2xl bg-slate-50 p-4">
          <p class="text-xs font-bold uppercase tracking-wide text-slate-400">Costo de ventas</p>
          <p class="mt-2 text-2xl font-bold text-rose-600">{{ formatMoney(cogsTotal) }}</p>
        </div>
        <div class="rounded-2xl bg-slate-50 p-4">
          <p class="text-xs font-bold uppercase tracking-wide text-slate-400">Ganancia bruta</p>
          <p class="mt-2 text-2xl font-bold" :class="grossProfitTotal >= 0 ? 'text-emerald-600' : 'text-rose-600'">
            {{ formatMoney(grossProfitTotal) }}
          </p>
        </div>
      </div>

      <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <div class="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
          <p class="text-xs font-bold uppercase tracking-wide text-slate-400">Margen</p>
          <p class="mt-2 text-xl font-bold text-slate-800">{{ formatPercent(marginPct) }}</p>
        </div>
        <div class="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
          <p class="text-xs font-bold uppercase tracking-wide text-slate-400">10% de ganancia</p>
          <p class="mt-2 text-xl font-bold text-indigo-600">{{ formatMoney(profitTenPercent) }}</p>
        </div>
        <div class="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
          <p class="text-xs font-bold uppercase tracking-wide text-slate-400">Neto despues del 10%</p>
          <p class="mt-2 text-xl font-bold text-slate-800">{{ formatMoney(netAfterProfitShare) }}</p>
        </div>
        <div class="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
          <p class="text-xs font-bold uppercase tracking-wide text-slate-400">Lectura</p>
          <p class="mt-2 text-sm font-semibold" :class="grossProfitTotal >= 0 ? 'text-emerald-700' : 'text-rose-700'">
            {{ grossProfitTotal >= 0 ? 'Operacion rentable' : 'Operacion en perdida' }}
          </p>
        </div>
      </div>

      <div class="flex flex-wrap gap-4 text-xs font-semibold text-slate-500">
        <div class="inline-flex items-center gap-2">
          <span class="h-2.5 w-2.5 rounded-full bg-rose-500" />
          <span>Costo de ventas</span>
        </div>
        <div v-if="grossProfitTotal > 0" class="inline-flex items-center gap-2">
          <span class="h-2.5 w-2.5 rounded-full bg-emerald-500" />
          <span>Ganancia bruta</span>
        </div>
        <div v-else-if="grossProfitTotal < 0" class="inline-flex items-center gap-2">
          <span class="h-2.5 w-2.5 rounded-full bg-rose-700" />
          <span>Perdida</span>
        </div>
      </div>
    </div>
  </section>
</template>
