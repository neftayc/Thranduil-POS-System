<script setup lang="ts">
import type { PropType } from 'vue'

type TrendSeries = {
  key: string
  label: string
  color: string
  values: number[]
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
  labels: {
    type: Array as PropType<string[]>,
    default: () => []
  },
  series: {
    type: Array as PropType<TrendSeries[]>,
    default: () => []
  },
  formatValue: {
    type: Function as PropType<(value: number) => string>,
    required: true
  },
  emptyState: {
    type: String,
    default: 'No hay datos para mostrar.'
  }
})

const chartWidth = computed(() => Math.max(720, props.labels.length * 64))
const chartHeight = 320
const padding = {
  top: 24,
  right: 24,
  bottom: 42,
  left: 64
}

const allValues = computed(() => props.series.flatMap((item) => item.values || []))

const minValue = computed(() => {
  if (!allValues.value.length) return 0
  const rawMin = Math.min(...allValues.value)
  const rawMax = Math.max(...allValues.value)
  const span = rawMax - rawMin || Math.max(1, Math.abs(rawMax) || Math.abs(rawMin) || 1)
  return rawMin - span * 0.08
})

const maxValue = computed(() => {
  if (!allValues.value.length) return 1
  const rawMin = Math.min(...allValues.value)
  const rawMax = Math.max(...allValues.value)
  const span = rawMax - rawMin || Math.max(1, Math.abs(rawMax) || Math.abs(rawMin) || 1)
  return rawMax + span * 0.08
})

const hasData = computed(
  () => props.labels.length > 0 && props.series.some((item) => (item.values || []).length > 0)
)

const yRange = computed(() => {
  const range = maxValue.value - minValue.value
  return range === 0 ? 1 : range
})

const xStep = computed(() => {
  const count = Math.max(props.labels.length - 1, 1)
  return (chartWidth.value - padding.left - padding.right) / count
})

const yForValue = (value: number) => {
  const innerHeight = chartHeight - padding.top - padding.bottom
  return (
    padding.top +
    ((maxValue.value - value) / yRange.value) * innerHeight
  )
}

const pointForIndex = (index: number, value: number) => ({
  x: padding.left + xStep.value * index,
  y: yForValue(value)
})

const seriesPaths = computed(() =>
  props.series.map((item) => {
    const points = item.values.map((value, index) => pointForIndex(index, value))
    const d = points
      .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
      .join(' ')

    return {
      ...item,
      points,
      d
    }
  })
)

const tickValues = computed(() => {
  const ticks = 4
  const values: number[] = []
  for (let index = 0; index <= ticks; index += 1) {
    values.push(minValue.value + (yRange.value * index) / ticks)
  }
  return values
})

const labelStep = computed(() => {
  if (props.labels.length <= 8) return 1
  if (props.labels.length <= 12) return 2
  return Math.ceil(props.labels.length / 10)
})
</script>

<template>
  <section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
    <div class="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h3 class="text-lg font-bold text-slate-800">{{ title }}</h3>
        <p v-if="subtitle" class="text-sm font-medium text-slate-500">{{ subtitle }}</p>
      </div>

      <div v-if="series.length" class="flex flex-wrap gap-3 text-xs font-semibold text-slate-500">
        <div v-for="item in series" :key="item.key" class="inline-flex items-center gap-2">
          <span class="h-2.5 w-2.5 rounded-full" :style="{ backgroundColor: item.color }" />
          <span>{{ item.label }}</span>
        </div>
      </div>
    </div>

    <div v-if="!hasData" class="mt-6 rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-10 text-center text-sm font-medium text-slate-400">
      {{ emptyState }}
    </div>

    <div v-else class="mt-5 overflow-x-auto">
      <svg
        :width="chartWidth"
        :height="chartHeight"
        :viewBox="`0 0 ${chartWidth} ${chartHeight}`"
        class="block"
        role="img"
        :aria-label="title"
      >
        <g v-for="tick in tickValues" :key="tick">
          <line
            :x1="padding.left"
            :x2="chartWidth - padding.right"
            :y1="yForValue(tick)"
            :y2="yForValue(tick)"
            stroke="#e2e8f0"
            stroke-width="1"
          />
          <text
            :x="padding.left - 10"
            :y="yForValue(tick) + 4"
            text-anchor="end"
            class="fill-slate-400 text-[11px] font-medium"
          >
            {{ formatValue(tick) }}
          </text>
        </g>

        <line
          v-if="minValue < 0 && maxValue > 0"
          :x1="padding.left"
          :x2="chartWidth - padding.right"
          :y1="yForValue(0)"
          :y2="yForValue(0)"
          stroke="#cbd5e1"
          stroke-width="1.5"
          stroke-dasharray="4 4"
        />

        <g v-for="item in seriesPaths" :key="item.key">
          <path
            :d="item.d"
            fill="none"
            :stroke="item.color"
            stroke-width="3"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <circle
            v-for="(point, pointIndex) in item.points"
            :key="`${item.key}-${pointIndex}`"
            :cx="point.x"
            :cy="point.y"
            r="4"
            fill="white"
            :stroke="item.color"
            stroke-width="2"
          />
        </g>

        <g
          v-for="(label, index) in labels"
          :key="`${label}-${index}`"
          :transform="`translate(${padding.left + xStep * index}, ${chartHeight - 16})`"
        >
          <text
            v-if="index % labelStep === 0 || index === labels.length - 1"
            text-anchor="middle"
            class="fill-slate-400 text-[11px] font-medium"
          >
            {{ label }}
          </text>
        </g>
      </svg>
    </div>
  </section>
</template>
