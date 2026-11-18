<script setup lang="ts">
definePageMeta({ middleware: ['reviewer'] })

type Option = { product_id: string; name: string }
type CaseLine = {
  n: number; phrase: string; product_id: string | null; name: string | null; quantity: number; unit: string | null
  price_said: number | null; list_price: number | null; options: Option[]; reasons: number[]
}
type CaseReason = { code: string; label: string; message: string; line: number | null; options: Option[] }
type ReviewCase = {
  id: string; version: string; seller_id: string; seller_name: string | null; saved_at: string; expires_at: string
  dictation: string[]; reasons: CaseReason[]; lines: CaseLine[]; payment_method: string; payment_defaulted: boolean
  price_review: boolean; notes: string[]; expired: boolean
}
type EditLine = {
  key: number; phrase: string; product_id: string | null; name: string | null; quantity: number; unit: string | null
  price_unit: string; price_said: number | null; list_price: number | null; options: Option[]; reasons: number[]
  search: string; results: Array<{ id: string; name: string; sale_price: number | null; unit: string | null }>
}
type Checked = { name: string; qty: number; unit_name: string; price_unit: number; list_price?: number; total: number; below_cost: boolean; unit_cost: number | null } | null
type Preview = {
  ok: boolean; errors: Array<{ line: number | null; message: string }>; lines: Checked[]; total: number; dry_run: boolean
  changes: Array<{ line: number; message: string }>; changes_token: string | null
}
type Edit = {
  lines: EditLine[]; payment_method: string; note: string; preview: Preview | null; previewKey: string
  busy: boolean; message: string; error: boolean; done: boolean; acceptChanges: boolean
}

const cases = ref<ReviewCase[]>([])
const paymentMethods = ref<Array<{ code: string; label: string }>>([])
const dryRun = ref(false)
const loading = ref(false)
const filter = ref<'pending' | 'expired' | 'all'>('pending')
const listMessage = ref('')
const edits = reactive<Record<string, Edit>>({})
let lineKey = 0

const money = (value: number | null | undefined) => (value === null || value === undefined ? '—' : `S/ ${Number(value).toFixed(2)}`)
const formatDate = (iso: string) => new Date(iso).toLocaleString('es-PE', { timeZone: 'America/Lima', dateStyle: 'short', timeStyle: 'short' })
const hoursLeft = (iso: string) => {
  const hours = (new Date(iso).getTime() - Date.now()) / 3_600_000
  return hours < 1 ? `vence en ${Math.max(0, Math.round(hours * 60))} min` : `vence en ${Math.round(hours)} h`
}
const errorText = (err: any, fallback: string) => err?.data?.statusMessage || err?.statusMessage || err?.message || fallback

const toEdit = (c: ReviewCase): Edit => ({
  lines: c.lines.map(l => ({
    key: ++lineKey, phrase: l.phrase, product_id: l.product_id, name: l.name, quantity: l.quantity, unit: l.unit,
    // Option A: a dictated price ≠ list is approved at that price (both prices are kept).
    price_unit: l.price_said !== null ? String(l.price_said) : '',
    price_said: l.price_said, list_price: l.list_price, options: l.options, reasons: l.reasons, search: '', results: []
  })),
  payment_method: c.payment_method || 'efectivo', note: '', preview: null, previewKey: '', busy: false, message: '', error: false, done: false, acceptChanges: false
})

const load = async () => {
  loading.value = true
  listMessage.value = ''
  try {
    const data = await $fetch<{ dry_run: boolean; cases: ReviewCase[]; payment_methods: Array<{ code: string; label: string }> }>('/api/agent/review', { query: { filter: filter.value } })
    dryRun.value = data.dry_run
    paymentMethods.value = data.payment_methods || []
    cases.value = data.cases || []
    for (const id of Object.keys(edits)) if (!cases.value.some(c => c.id === id)) delete edits[id]
    for (const c of cases.value) if (!edits[c.id]) edits[c.id] = toEdit(c)
  } catch (err: any) {
    listMessage.value = errorText(err, 'No se pudieron cargar las ventas por confirmar.')
  } finally {
    loading.value = false
  }
}

const payload = (c: ReviewCase) => {
  const e = edits[c.id]
  return {
    version: c.version,
    payment_method: e.payment_method,
    accept_changes: e.acceptChanges && e.preview?.changes_token ? e.preview.changes_token : undefined,
    note: e.note,
    lines: e.lines.map(l => ({
      product_id: l.product_id, quantity: Number(l.quantity), unit: l.unit || null,
      price_unit: String(l.price_unit).trim() === '' ? null : Number(l.price_unit)
    }))
  }
}
const keyOf = (c: ReviewCase) => JSON.stringify({ ...payload(c), accept_changes: undefined })
const previewFresh = (c: ReviewCase) => {
  const e = edits[c.id]
  return Boolean(e.preview?.ok && e.previewKey === keyOf(c) && (!e.preview.changes.length || e.acceptChanges))
}

const verify = async (c: ReviewCase) => {
  const e = edits[c.id]
  e.busy = true
  e.message = ''
  try {
    const body = payload(c)
    e.preview = await $fetch<Preview>(`/api/agent/review/${c.id}/preview`, { method: 'POST', body })
    e.previewKey = keyOf(c)
    e.acceptChanges = false
    e.error = !e.preview.ok
    e.message = e.preview.ok ? `Todo verificado. Total ${money(e.preview.total)}.` : 'Corrige lo indicado antes de aprobar.'
  } catch (err: any) {
    e.error = true
    e.message = errorText(err, 'No se pudo verificar.')
  } finally {
    e.busy = false
  }
}

const approve = async (c: ReviewCase) => {
  const e = edits[c.id]
  if (!previewFresh(c)) return verify(c)
  if (!confirm(`${dryRun.value ? 'SIMULACIÓN: no se registrará nada. ' : ''}¿Registrar esta venta por ${money(e.preview!.total)}?`)) return
  e.busy = true
  e.message = ''
  try {
    const res = await $fetch<{ message: string }>(`/api/agent/review/${c.id}/approve`, { method: 'POST', body: payload(c) })
    e.done = true
    e.error = false
    e.message = res.message
  } catch (err: any) {
    e.error = true
    const errors = err?.data?.data?.errors as Array<{ message: string }> | undefined
    e.message = errors?.length ? errors.map(x => x.message).join(' ') : errorText(err, 'No se pudo aprobar.')
  } finally {
    e.busy = false
  }
}

const annul = async (c: ReviewCase) => {
  const e = edits[c.id]
  if (!confirm('¿Anular esta venta por confirmar? No se registrará y se liberará su reserva de stock.')) return
  e.busy = true
  e.message = ''
  try {
    const res = await $fetch<{ message: string }>(`/api/agent/review/${c.id}/annul`, { method: 'POST', body: { version: c.version, note: e.note } })
    e.done = true
    e.error = false
    e.message = res.message
  } catch (err: any) {
    e.error = true
    e.message = errorText(err, 'No se pudo anular.')
  } finally {
    e.busy = false
  }
}

const choose = (line: EditLine, option: { product_id: string; name: string }) => {
  line.product_id = option.product_id
  line.name = option.name
  line.search = ''
  line.results = []
}
const searchProducts = async (line: EditLine) => {
  const q = line.search.trim()
  if (q.length < 2) { line.results = []; return }
  try {
    line.results = (await $fetch<any[]>('/api/products/search', { query: { q } })).slice(0, 8)
  } catch {
    line.results = []
  }
}
const addLine = (c: ReviewCase) => {
  edits[c.id].lines.push({
    key: ++lineKey, phrase: '(línea agregada en revisión)', product_id: null, name: null, quantity: 1, unit: null,
    price_unit: '', price_said: null, list_price: null, options: [], reasons: [], search: '', results: []
  })
}
const removeLine = (c: ReviewCase, key: number) => {
  edits[c.id].lines = edits[c.id].lines.filter(l => l.key !== key)
}
const generalReasons = (c: ReviewCase) => c.reasons.filter(r => r.line === null)

onMounted(load)
</script>

<template>
  <div class="space-y-6">
    <section class="ui-card">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 class="ui-heading">Ventas por confirmar</h2>
          <p class="ui-subtitle">
            Ventas dictadas al agente de voz que no se registraron solas. Elige el producto, ajusta cantidad o precio,
            verifica y aprueba; o anúlala. Mientras esperan, su stock queda reservado.
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <select v-model="filter" class="ui-select w-40" @change="load">
            <option value="pending">Pendientes</option>
            <option value="expired">Vencidas</option>
            <option value="all">Todas</option>
          </select>
          <button class="ui-btn-secondary" :disabled="loading" @click="load">{{ loading ? 'Cargando…' : 'Actualizar' }}</button>
        </div>
      </div>
      <div v-if="dryRun" class="ui-alert mt-4">
        Modo simulación (POS_AGENT_DRY_RUN): aprobar solo muestra lo que se registraría; no se crea ninguna venta.
      </div>
      <div v-if="listMessage" class="ui-alert-error mt-4">{{ listMessage }}</div>
      <p v-if="!loading && !cases.length && !listMessage" class="ui-empty-state mt-4">
        {{ filter === 'expired' ? 'No hay ventas vencidas.' : filter === 'all' ? 'No hay ventas por confirmar ni vencidas.' : 'No hay ventas por confirmar.' }}
      </p>
    </section>

    <section v-for="c in cases" :key="c.id" class="ui-card">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 class="text-base font-semibold text-slate-800">
            {{ c.seller_name || 'Vendedor ' + c.seller_id.slice(0, 8) }}
            <span class="ui-meta-chip ml-2">{{ formatDate(c.saved_at) }}</span>
            <span v-if="c.expired" class="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">Vencida</span>
            <span v-else class="ui-pill-low ml-2">{{ hoursLeft(c.expires_at) }}</span>
          </h3>
          <p class="mt-1 text-xs text-slate-500">Referencia {{ c.id }}</p>
          <p v-if="c.expired" class="mt-1 text-xs text-red-700">
            Venció el {{ formatDate(c.expires_at) }}: ya no tiene stock reservado. Al aprobar se vuelven a revisar el stock y el precio.
          </p>
        </div>
      </div>

      <div class="ui-subcard mt-4">
        <p class="ui-label">Lo que dictó</p>
        <p v-for="(m, i) in c.dictation" :key="i" class="text-sm italic text-slate-700">«{{ m }}»</p>
      </div>

      <div v-if="generalReasons(c).length" class="mt-4 space-y-1">
        <p class="ui-label">Por qué quedó por confirmar</p>
        <p v-for="(r, i) in generalReasons(c)" :key="i" class="text-sm text-slate-700">
          <span class="font-semibold">{{ r.label }}:</span> {{ r.message }}
        </p>
      </div>

      <template v-if="!edits[c.id]?.done">
        <div class="mt-4 space-y-3">
          <div v-for="(line, index) in edits[c.id].lines" :key="line.key" class="ui-subcard">
            <div class="flex flex-wrap items-start justify-between gap-2">
              <p class="text-sm text-slate-600">Línea {{ index + 1 }} · «{{ line.phrase }}»</p>
              <button class="ui-btn-secondary !px-2 !py-1 text-xs" @click="removeLine(c, line.key)">Quitar línea</button>
            </div>
            <p v-for="ri in line.reasons" :key="ri" class="mt-1 text-sm text-amber-700">
              <span class="font-semibold">{{ c.reasons[ri].label }}:</span> {{ c.reasons[ri].message }}
            </p>

            <div class="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <div class="xl:col-span-2">
                <label class="ui-label">Producto</label>
                <p class="text-sm font-semibold text-slate-800">{{ line.name || (line.product_id ? 'Producto ' + line.product_id.slice(0, 8) : 'Sin elegir') }}</p>
                <div v-if="line.options.length" class="mt-2 flex flex-wrap gap-2">
                  <button v-for="o in line.options" :key="o.product_id" class="ui-btn-secondary !px-2 !py-1 text-xs" @click="choose(line, o)">{{ o.name }}</button>
                </div>
                <input v-model="line.search" class="ui-input mt-2" type="text" placeholder="Buscar otro producto…" @input="searchProducts(line)" />
                <div v-if="line.results.length" class="mt-1 rounded border border-slate-200 bg-white">
                  <button
                    v-for="p in line.results" :key="p.id"
                    class="block w-full px-3 py-1 text-left text-sm hover:bg-slate-50"
                    @click="choose(line, { product_id: p.id, name: p.name })"
                  >
                    {{ p.name }} <span class="text-slate-400">· {{ money(p.sale_price) }} / {{ p.unit || 'unidad' }}</span>
                  </button>
                </div>
              </div>
              <div>
                <label class="ui-label">Cantidad</label>
                <input v-model.number="line.quantity" class="ui-input" type="number" min="0" step="any" />
                <label class="ui-label mt-2">Presentación</label>
                <input v-model="line.unit" class="ui-input" type="text" placeholder="unidad" />
              </div>
              <div>
                <label class="ui-label">Precio unitario</label>
                <input v-model="line.price_unit" class="ui-input" type="number" min="0" step="0.01" :placeholder="line.list_price !== null ? 'Lista ' + money(line.list_price) : 'Precio de lista'" />
                <p class="mt-1 text-xs text-slate-500">
                  Vacío = precio de lista<template v-if="line.list_price !== null"> ({{ money(line.list_price) }})</template>.
                  <template v-if="line.price_said !== null"> Dictado: {{ money(line.price_said) }}.</template>
                </p>
              </div>
            </div>

            <div v-if="edits[c.id].preview && edits[c.id].preview!.lines[index]" class="mt-2 text-sm text-slate-700">
              ✓ {{ edits[c.id].preview!.lines[index]!.qty }} {{ edits[c.id].preview!.lines[index]!.unit_name }} ×
              {{ money(edits[c.id].preview!.lines[index]!.price_unit) }} = {{ money(edits[c.id].preview!.lines[index]!.total) }}
              <span v-if="edits[c.id].preview!.lines[index]!.list_price !== undefined" class="text-amber-700">
                (lista {{ money(edits[c.id].preview!.lines[index]!.list_price) }})
              </span>
              <span v-if="edits[c.id].preview!.lines[index]!.below_cost" class="font-semibold text-red-600">
                · bajo costo ({{ money(edits[c.id].preview!.lines[index]!.unit_cost) }})
              </span>
            </div>
          </div>
          <button class="ui-btn-secondary" @click="addLine(c)">+ Agregar línea</button>
        </div>

        <div class="mt-4 grid gap-3 sm:grid-cols-2">
          <div>
            <label class="ui-label">Forma de pago</label>
            <select v-model="edits[c.id].payment_method" class="ui-select">
              <option v-for="m in paymentMethods" :key="m.code" :value="m.code">{{ m.label }}</option>
            </select>
            <p v-if="c.payment_defaulted" class="mt-1 text-xs text-slate-500">El vendedor no dijo forma de pago: efectivo por defecto.</p>
          </div>
          <div>
            <label class="ui-label">Nota (opcional)</label>
            <input v-model="edits[c.id].note" class="ui-input" type="text" placeholder="Queda en el registro de la revisión" />
          </div>
        </div>

        <ul v-if="edits[c.id].preview && !edits[c.id].preview!.ok" class="ui-alert-error mt-4 list-disc pl-6">
          <li v-for="(err, i) in edits[c.id].preview!.errors" :key="i">{{ err.message }}</li>
        </ul>

        <div v-if="edits[c.id].preview?.ok && edits[c.id].preview!.changes.length" class="ui-alert mt-4">
          <p class="font-semibold">Cambió desde el dictado:</p>
          <p v-for="(ch, i) in edits[c.id].preview!.changes" :key="i">{{ ch.message }}</p>
          <label class="mt-2 flex items-center gap-2">
            <input v-model="edits[c.id].acceptChanges" type="checkbox" />
            Acepto estos cambios y quiero registrar la venta con los datos actuales.
          </label>
        </div>

        <div class="mt-5 flex flex-wrap gap-3">
          <button class="ui-btn-secondary" :disabled="edits[c.id].busy" @click="verify(c)">Verificar</button>
          <button class="ui-btn" :disabled="edits[c.id].busy || !previewFresh(c)" @click="approve(c)">
            {{ dryRun ? 'Aprobar (simulación)' : 'Aprobar y registrar' }}
            <template v-if="previewFresh(c)"> · {{ money(edits[c.id].preview!.total) }}</template>
          </button>
          <button class="ui-btn-secondary" :disabled="edits[c.id].busy" @click="annul(c)">Anular</button>
        </div>
      </template>

      <div v-if="edits[c.id]?.message" class="mt-4" :class="edits[c.id].error ? 'ui-alert-error' : 'ui-alert'">
        {{ edits[c.id].message }}
      </div>
    </section>
  </div>
</template>
