<script setup lang="ts">
import type { PropType } from 'vue'

type BarSeries = {
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
    type: Array as PropType<BarSeries[]>,
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

const chartWidth = computed(() => Math.max(760, props.labels.length * 72))
const chartHeight = 360
const padding = {
  top: 24,
  right: 24,
  bottom: 46,
  left: 68
}

const allValues = computed(() => props.series.flatMap((item) => item.values || []))

const minValue = computed(() => {
  if (!allValues.value.length) return 0
  const rawMin = Math.min(...allValues.value)
  const rawMax = Math.max(...allValues.value)
  const span = rawMax - rawMin || Math.max(1, Math.abs(rawMax) || Math.abs(rawMin) || 1)
  return rawMin - span * 0.1
})

const maxValue = computed(() => {
  if (!allValues.value.length) return 1
  const rawMin = Math.min(...allValues.value)
  const rawMax = Math.max(...allValues.value)
  const span = rawMax - rawMin || Math.max(1, Math.abs(rawMax) || Math.abs(rawMin) || 1)
  return rawMax + span * 0.1
})

const hasData = computed(
  () => props.labels.length > 0 && props.series.some((item) => (item.values || []).length > 0)
)

const range = computed(() => {
  const value = maxValue.value - minValue.value
  return value === 0 ? 1 : value
})

const innerWidth = computed(() => chartWidth.value - padding.left - padding.right)
const innerHeight = computed(() => chartHeight - padding.top - padding.bottom)

const yForValue = (value: number) =>
  padding.top + ((maxValue.value - value) / range.value) * innerHeight.value

const zeroY = computed(() => {
  if (minValue.value >= 0) return chartHeight - padding.bottom
  if (maxValue.value <= 0) return padding.top
  return yForValue(0)
})

const groupWidth = computed(() => innerWidth.value / Math.max(props.labels.length, 1))
const seriesGap = computed(() => Math.min(10, Math.max(4, groupWidth.value * 0.08)))
const barWidth = computed(() => {
  const seriesCount = Math.max(props.series.length, 1)
  const available = Math.max(8, groupWidth.value - seriesGap.value * 2)
  return Math.min(22, available / seriesCount)
})

const barGroups = computed(() =>
  props.labels.map((label, index) => {
    const groupCenter = padding.left + groupWidth.value * index + groupWidth.value / 2
    const totalBarsWidth = barWidth.value * props.series.length + seriesGap.value * Math.max(props.series.length - 1, 0)
    const startX = groupCenter - totalBarsWidth / 2

    return {
      label,
      index,
      bars: props.series.map((series, seriesIndex) => {
        const value = Number(series.values?.[index] || 0)
        const x = startX + seriesIndex * (barWidth.value + seriesGap.value)
        const valueY = yForValue(value)
        const baseY = zeroY.value
        const y = Math.min(valueY, baseY)
        const height = Math.max(0, Math.abs(baseY - valueY))

        return {
          ...series,
          value,
          x,
          y,
          height
        }
      })
    }
  })
)

const tickValues = computed(() => {
  const ticks = 4
  const values: number[] = []
  for (let index = 0; index <= ticks; index += 1) {
    values.push(minValue.value + (range.value * index) / ticks)
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
  <section class="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
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

    <div
      v-if="!hasData"
      class="mt-6 rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-10 text-center text-sm font-medium text-slate-400"
    >
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
          :x1="padding.left"
          :x2="chartWidth - padding.right"
          :y1="zeroY"
          :y2="zeroY"
          stroke="#cbd5e1"
          stroke-width="1.5"
          stroke-dasharray="4 4"
        />

        <g v-for="group in barGroups" :key="group.label">
          <g v-for="bar in group.bars" :key="`${group.label}-${bar.key}`">
            <rect
              :x="bar.x"
              :y="bar.y"
              :width="barWidth"
              :height="bar.height"
              :rx="8"
              :fill="bar.color"
              opacity="0.9"
            />
          </g>

          <text
            v-if="group.index % labelStep === 0 || group.index === labels.length - 1"
            :x="padding.left + groupWidth * group.index + groupWidth / 2"
            :y="chartHeight - 16"
            text-anchor="middle"
            class="fill-slate-400 text-[11px] font-medium"
          >
            {{ group.label }}
          </text>
        </g>
      </svg>
    </div>
  </section>
</template>
