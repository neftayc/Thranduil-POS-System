<script setup lang="ts">
withDefaults(
  defineProps<{
    compact?: boolean
    light?: boolean
    subtitle?: string
  }>(),
  {
    compact: false,
    light: false,
    subtitle: 'Retail OS'
  }
)

const brandName = 'THRANDUIL'
</script>

<template>
  <div class="flex items-center gap-3" :class="compact ? 'justify-center' : ''">
    <span
      class="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-lg shadow-indigo-900/40"
      aria-hidden="true"
    >
      <svg viewBox="0 0 48 48" class="h-7 w-7" fill="none">
        <path
          d="M8 10.5L24 5L40 10.5V22C40 31.2 33.4 39 24 42.2C14.6 39 8 31.2 8 22V10.5Z"
          stroke="currentColor"
          stroke-width="2.2"
          stroke-linejoin="round"
        />
        <path
          d="M15 16H33M24 16V33"
          stroke="currentColor"
          stroke-width="2.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <path
          d="M18 24H30"
          stroke="currentColor"
          stroke-width="2.6"
          stroke-linecap="round"
        />
      </svg>
    </span>

    <div v-if="!compact" class="min-w-0">
      <p
        class="truncate text-[11px] font-semibold uppercase tracking-[0.22em]"
        :class="light ? 'text-indigo-300' : 'text-slate-500'"
      >
        Sistema
      </p>
      <p
        class="mt-0.5 truncate text-2xl font-display leading-none"
        :class="light ? 'text-white' : 'text-slate-800'"
      >
        {{ brandName }}
      </p>
      <p class="mt-1 truncate text-xs" :class="light ? 'text-slate-300' : 'text-slate-500'">{{ subtitle }}</p>
    </div>
  </div>
</template>
