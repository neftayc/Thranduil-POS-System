<script setup lang="ts">
// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────
type Institution = {
  id: string;
  name: string;
  short_name: string | null;
  active: boolean;
};
type Grade = {
  id: string;
  institution_id: string;
  level: string;
  name: string;
  sort_order: number;
  active: boolean;
};
type Section = { id: string; grade_id: string; name: string; active: boolean };
type SchoolList = {
  id: string;
  institution_id: string;
  grade_id: string;
  section_id: string;
  year: number;
  active: boolean;
  notes: string | null;
};
type ListItem = {
  id: string;
  list_id: string;
  item_description: string;
  qty: number;
  notes: string | null;
  sort_order: number;
};
type ItemBrand = {
  id: string;
  item_id: string;
  brand: string;
  is_default: boolean;
  product_id: string;
  product_name?: string;
};

const activeTab = ref<"institutions" | "grades" | "lists">("institutions");
const message = ref("");
const loading = ref(false);

// ──────────────────────────────────────────────
// Tab 1: Institutions
// ──────────────────────────────────────────────
const institutions = ref<Institution[]>([]);
const showInstModal = ref(false);
const instForm = reactive({ id: "", name: "", short_name: "", active: true });
const isEditingInst = computed(() => Boolean(instForm.id));

const loadInstitutions = async () => {
  loading.value = true;
  try {
    const data = await $fetch<Institution[]>("/api/school/institutions");
    institutions.value = data || [];
  } catch (e: any) {
    message.value = e?.data?.statusMessage || "Error cargando instituciones";
  } finally {
    loading.value = false;
  }
};

const openNewInst = () => {
  Object.assign(instForm, { id: "", name: "", short_name: "", active: true });
  message.value = "";
  showInstModal.value = true;
};

const editInst = (inst: Institution) => {
  Object.assign(instForm, {
    id: inst.id,
    name: inst.name,
    short_name: inst.short_name || "",
    active: inst.active,
  });
  message.value = "";
  showInstModal.value = true;
};

const saveInst = async () => {
  loading.value = true;
  message.value = "";
  try {
    await $fetch("/api/school/institutions", {
      method: "POST",
      body: {
        id: instForm.id || undefined,
        name: instForm.name,
        short_name: instForm.short_name || null,
        active: instForm.active,
      },
    });
    showInstModal.value = false;
    await loadInstitutions();
  } catch (e: any) {
    message.value = e?.data?.statusMessage || "Error guardando";
  } finally {
    loading.value = false;
  }
};

// ──────────────────────────────────────────────
// Tab 2: Grades & Sections
// ──────────────────────────────────────────────
const selectedInstitutionId = ref("");
const grades = ref<Grade[]>([]);
const sections = ref<{ [gradeId: string]: Section[] }>({});
const expandedGrade = ref("");

const showGradeModal = ref(false);
const gradeForm = reactive({
  id: "",
  name: "",
  level: "primaria",
  sort_order: 0,
  active: true,
});
const isEditingGrade = computed(() => Boolean(gradeForm.id));

const showSectionModal = ref(false);
const sectionForm = reactive({ id: "", grade_id: "", name: "", active: true });

const loadGrades = async () => {
  if (!selectedInstitutionId.value) return;
  loading.value = true;
  try {
    const data = await $fetch<Grade[]>(
      `/api/school/grades?institution_id=${selectedInstitutionId.value}`,
    );
    grades.value = data || [];
    sections.value = {};
  } catch (e: any) {
    message.value = e?.data?.statusMessage || "Error cargando grados";
  } finally {
    loading.value = false;
  }
};

const loadSections = async (gradeId: string) => {
  try {
    const data = await $fetch<Section[]>(
      `/api/school/sections?grade_id=${gradeId}`,
    );
    sections.value = { ...sections.value, [gradeId]: data || [] };
  } catch (e: any) {
    message.value = e?.data?.statusMessage || "Error cargando secciones";
  }
};

const toggleGrade = async (gradeId: string) => {
  if (expandedGrade.value === gradeId) {
    expandedGrade.value = "";
    return;
  }
  expandedGrade.value = gradeId;
  if (!sections.value[gradeId]) await loadSections(gradeId);
};

const openNewGrade = () => {
  Object.assign(gradeForm, {
    id: "",
    name: "",
    level: "primaria",
    sort_order: grades.value.length,
    active: true,
  });
  message.value = "";
  showGradeModal.value = true;
};

const editGrade = (g: Grade) => {
  Object.assign(gradeForm, {
    id: g.id,
    name: g.name,
    level: g.level,
    sort_order: g.sort_order,
    active: g.active,
  });
  message.value = "";
  showGradeModal.value = true;
};

const saveGrade = async () => {
  loading.value = true;
  message.value = "";
  try {
    await $fetch("/api/school/grades", {
      method: "POST",
      body: {
        id: gradeForm.id || undefined,
        institution_id: selectedInstitutionId.value,
        name: gradeForm.name,
        level: gradeForm.level,
        sort_order: gradeForm.sort_order,
        active: gradeForm.active,
      },
    });
    showGradeModal.value = false;
    await loadGrades();
  } catch (e: any) {
    message.value = e?.data?.statusMessage || "Error guardando";
  } finally {
    loading.value = false;
  }
};

const openNewSection = (gradeId: string) => {
  Object.assign(sectionForm, {
    id: "",
    grade_id: gradeId,
    name: "",
    active: true,
  });
  message.value = "";
  showSectionModal.value = true;
};

const editSection = (s: Section) => {
  Object.assign(sectionForm, {
    id: s.id,
    grade_id: s.grade_id,
    name: s.name,
    active: s.active,
  });
  message.value = "";
  showSectionModal.value = true;
};

const saveSection = async () => {
  loading.value = true;
  message.value = "";
  try {
    await $fetch("/api/school/sections", {
      method: "POST",
      body: {
        id: sectionForm.id || undefined,
        grade_id: sectionForm.grade_id,
        name: sectionForm.name,
        active: sectionForm.active,
      },
    });
    showSectionModal.value = false;
    await loadSections(sectionForm.grade_id);
  } catch (e: any) {
    message.value = e?.data?.statusMessage || "Error guardando";
  } finally {
    loading.value = false;
  }
};

// ──────────────────────────────────────────────
// Tab 3: Lists
// ──────────────────────────────────────────────
const listInstitutionId = ref("");
const listGrades = ref<Grade[]>([]);
const listGradeId = ref("");
const listSections = ref<Section[]>([]);
const listSectionId = ref("");
const listYear = ref(new Date().getFullYear());

const currentList = ref<SchoolList | null>(null);
const listItems = ref<ListItem[]>([]);
const itemBrands = ref<{ [itemId: string]: ItemBrand[] }>({});

// Item form
const showItemModal = ref(false);
const itemForm = reactive({
  id: "",
  item_description: "",
  qty: 1,
  notes: "",
  sort_order: 0,
});
const isEditingItem = computed(() => Boolean(itemForm.id));

// Product search inside item modal for auto-brand
const itemDescSearch = ref("");
const itemDescResults = ref<any[]>([]);
const itemSearchLoading = ref(false);
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
// Products queued to become brand variants when the item is saved.
// brandId: id de la fila en school_list_item_brands (solo si ya existe en DB)
const pendingProducts = ref<
  { id: string; name: string; brand: string | null; brandId?: string }[]
>([]);
// Snapshot de marcas al abrir el modal de edición (para calcular diff al guardar)
let originalBrands: ItemBrand[] = [];

const loadListGrades = async () => {
  if (!listInstitutionId.value) return;
  listGradeId.value = "";
  listSectionId.value = "";
  currentList.value = null;
  listItems.value = [];
  const data = await $fetch<Grade[]>(
    `/api/school/grades?institution_id=${listInstitutionId.value}`,
  );
  listGrades.value = data || [];
};

const loadListSections = async () => {
  if (!listGradeId.value) return;
  listSectionId.value = "";
  currentList.value = null;
  listItems.value = [];
  const data = await $fetch<Section[]>(
    `/api/school/sections?grade_id=${listGradeId.value}`,
  );
  listSections.value = data || [];
};

const loadList = async () => {
  if (!listInstitutionId.value || !listGradeId.value || !listSectionId.value)
    return;
  loading.value = true;
  message.value = "";
  try {
    const data = await $fetch<{ list: SchoolList | null; items: ListItem[] }>(
      "/api/school/lists",
      {
        query: {
          institution_id: listInstitutionId.value,
          grade_id: listGradeId.value,
          section_id: listSectionId.value,
          year: listYear.value,
        },
      },
    );
    currentList.value = data.list;
    listItems.value = data.items || [];
    itemBrands.value = {};
    for (const item of listItems.value) {
      await loadItemBrands(item.id);
    }
  } catch (e: any) {
    message.value = e?.data?.statusMessage || "Error cargando lista";
  } finally {
    loading.value = false;
  }
};

const createList = async () => {
  loading.value = true;
  message.value = "";
  try {
    const data = await $fetch<SchoolList>("/api/school/lists", {
      method: "POST",
      body: {
        institution_id: listInstitutionId.value,
        grade_id: listGradeId.value,
        section_id: listSectionId.value,
        year: listYear.value,
      },
    });
    currentList.value = data;
    listItems.value = [];
  } catch (e: any) {
    message.value = e?.data?.statusMessage || "Error creando lista";
  } finally {
    loading.value = false;
  }
};

const toggleListActive = async () => {
  if (!currentList.value) return;
  loading.value = true;
  try {
    const updated = await $fetch<SchoolList>("/api/school/lists", {
      method: "PATCH",
      body: { id: currentList.value.id, active: !currentList.value.active },
    });
    currentList.value = updated;
  } catch (e: any) {
    message.value = e?.data?.statusMessage || "Error actualizando";
  } finally {
    loading.value = false;
  }
};

const loadItemBrands = async (itemId: string) => {
  const data = await $fetch<ItemBrand[]>(
    `/api/school/item-brands?item_id=${itemId}`,
  );
  itemBrands.value = { ...itemBrands.value, [itemId]: data || [] };
};

const openNewItem = () => {
  Object.assign(itemForm, {
    id: "",
    item_description: "",
    qty: 1,
    notes: "",
    sort_order: listItems.value.length
      ? Math.max(...listItems.value.map((i) => i.sort_order)) + 1
      : 0,
  });
  itemDescSearch.value = "";
  itemDescResults.value = [];
  pendingProducts.value = [];
  message.value = "";
  showItemModal.value = true;
};

const editItem = async (item: ListItem) => {
  Object.assign(itemForm, {
    id: item.id,
    item_description: item.item_description,
    qty: item.qty,
    notes: item.notes || "",
    sort_order: item.sort_order,
  });
  itemDescSearch.value = "";
  itemDescResults.value = [];
  message.value = "";

  // Cargar marcas existentes y pre-poblar la lista de productos pendientes
  try {
    const existingBrands = await $fetch<ItemBrand[]>(
      `/api/school/item-brands?item_id=${item.id}`,
    );
    originalBrands = existingBrands || []; // snapshot para el diff
    pendingProducts.value = originalBrands.map((b) => ({
      id: b.product_id,
      name: b.product_name || b.brand,
      brand: b.brand,
      brandId: b.id, // id en school_list_item_brands
    }));
  } catch {
    originalBrands = [];
    pendingProducts.value = [];
  }

  showItemModal.value = true;
};

const searchItemProducts = () => {
  // Cancelar búsqueda anterior
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);

  const q = itemDescSearch.value.trim();
  if (q.length < 2) {
    itemDescResults.value = [];
    itemSearchLoading.value = false;
    return;
  }

  // Mostrar spinner inmediatamente para feedback visual
  itemSearchLoading.value = true;

  // Esperar 300ms antes de lanzar la petición (debounce)
  searchDebounceTimer = setTimeout(async () => {
    try {
      const data = await $fetch<any[]>("/api/products/search", {
        query: { q },
      });
      itemDescResults.value = data || [];
    } catch {
      itemDescResults.value = [];
    } finally {
      itemSearchLoading.value = false;
    }
  }, 300);
};

const addProductToItem = (product: any) => {
  // Fill description with first product if empty
  if (!itemForm.item_description) itemForm.item_description = product.name;
  // Queue product for auto-brand creation (avoid duplicates)
  if (!pendingProducts.value.find((p) => p.id === product.id)) {
    pendingProducts.value.push({
      id: product.id,
      name: product.name,
      brand: product.brand || null,
    });
  }
};

const removePendingProduct = (productId: string) => {
  pendingProducts.value = pendingProducts.value.filter(
    (p) => p.id !== productId,
  );
};

const saveItem = async () => {
  if (!currentList.value) return;
  loading.value = true;
  message.value = "";
  try {
    const savedItem = await $fetch<ListItem>("/api/school/list-items", {
      method: "POST",
      body: {
        id: itemForm.id || undefined,
        list_id: currentList.value.id,
        item_description: itemForm.item_description,
        qty: itemForm.qty,
        notes: itemForm.notes || null,
        sort_order: itemForm.sort_order,
      },
    });

    // ── Marcas: reemplazo completo ────────────────────────────────────
    // Si es edición, borrar todas las marcas existentes de una sola vez;
    // luego insertar las que están actualmente en pendingProducts.
    if (itemForm.id) {
      await $fetch(`/api/school/item-brands?item_id=${savedItem.id}`, {
        method: "DELETE",
      });
    }
    for (const p of pendingProducts.value) {
      await $fetch("/api/school/item-brands", {
        method: "POST",
        body: {
          item_id: savedItem.id,
          product_id: p.id,
          brand: p.brand || p.name,
        },
      });
    }

    showItemModal.value = false;
    await loadList();
  } catch (e: any) {
    message.value = e?.data?.statusMessage || "Error guardando ítem";
  } finally {
    loading.value = false;
  }
};

const deleteItem = async (itemId: string) => {
  if (!confirm("¿Eliminar este ítem?")) return;
  loading.value = true;
  try {
    await $fetch(`/api/school/list-items?id=${itemId}`, { method: "DELETE" });
    await loadList();
  } catch (e: any) {
    message.value = e?.data?.statusMessage || "Error eliminando";
  } finally {
    loading.value = false;
  }
};

const deleteBrand = async (brand: ItemBrand) => {
  if (!confirm("¿Eliminar esta variante de marca?")) return;
  loading.value = true;
  try {
    await $fetch(`/api/school/item-brands?id=${brand.id}`, {
      method: "DELETE",
    });
    await loadItemBrands(brand.item_id);
  } catch (e: any) {
    message.value = e?.data?.statusMessage || "Error eliminando";
  } finally {
    loading.value = false;
  }
};

const levelLabel = (level: string) =>
  ({ inicial: "Inicial", primaria: "Primaria", secundaria: "Secundaria" })[
    level
  ] || level;

watch(selectedInstitutionId, loadGrades);
watch(listInstitutionId, loadListGrades);
watch(listGradeId, loadListSections);

onMounted(loadInstitutions);
</script>

<template>
  <div class="space-y-6">
    <!-- Tabs -->
    <section class="ui-card card-hover">
      <div class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 class="ui-heading">Listas Escolares</h2>
          <p class="ui-subtitle">
            Gestiona colegios, grados, secciones y listas de útiles para
            WhatsApp.
          </p>
        </div>
      </div>

      <div
        v-if="message"
        class="mt-4"
        :class="
          message.toLowerCase().includes('error')
            ? 'ui-alert-error'
            : 'ui-alert'
        "
      >
        {{ message }}
      </div>

      <!-- Tab Nav -->
      <div class="mt-5 flex gap-1 rounded-xl bg-slate-100 p-1">
        <button
          v-for="tab in [
            { id: 'institutions', label: '🏫 Instituciones' },
            { id: 'grades', label: '📚 Grados & Secciones' },
            { id: 'lists', label: '📋 Listas de Útiles' },
          ]"
          :key="tab.id"
          class="flex-1 rounded-lg py-2 text-sm font-semibold transition"
          :class="
            activeTab === tab.id
              ? 'bg-white text-indigo-700 shadow'
              : 'text-slate-500 hover:text-slate-700'
          "
          @click="activeTab = tab.id as any"
        >
          {{ tab.label }}
        </button>
      </div>
    </section>

    <!-- ═══════════════════════════════════════════════
         TAB 1: INSTITUTIONS
    ════════════════════════════════════════════════ -->
    <section v-if="activeTab === 'institutions'" class="ui-card card-hover">
      <div class="flex items-center justify-between gap-3">
        <h3 class="text-base font-bold text-slate-700">
          Instituciones registradas
        </h3>
        <button class="ui-btn" @click="openNewInst">+ Nueva institución</button>
      </div>

      <div class="ui-table-wrap mt-5">
        <table class="ui-table">
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Alias WhatsApp</th>
              <th>Estado</th>
              <th>Acción</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="inst in institutions" :key="inst.id">
              <td class="font-semibold text-slate-800">{{ inst.name }}</td>
              <td class="text-slate-500">{{ inst.short_name || "-" }}</td>
              <td>
                <span
                  class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold"
                  :class="
                    inst.active
                      ? 'bg-emerald-100 text-emerald-700'
                      : 'bg-slate-100 text-slate-500'
                  "
                >
                  {{ inst.active ? "Activo" : "Inactivo" }}
                </span>
              </td>
              <td>
                <button
                  class="ui-btn-secondary px-3 py-2"
                  @click="editInst(inst)"
                >
                  Editar
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="!institutions.length && !loading" class="ui-empty-state mt-4">
        No hay instituciones registradas.
      </p>
    </section>

    <!-- ═══════════════════════════════════════════════
         TAB 2: GRADES & SECTIONS
    ════════════════════════════════════════════════ -->
    <section v-if="activeTab === 'grades'" class="ui-card card-hover space-y-5">
      <div class="flex flex-wrap items-end gap-4">
        <div class="flex-1 min-w-[200px]">
          <label class="ui-label">Institución</label>
          <select v-model="selectedInstitutionId" class="ui-select">
            <option value="">Selecciona una institución...</option>
            <option
              v-for="inst in institutions"
              :key="inst.id"
              :value="inst.id"
            >
              {{ inst.name }}
            </option>
          </select>
        </div>
        <button
          v-if="selectedInstitutionId"
          class="ui-btn"
          @click="openNewGrade"
        >
          + Nuevo grado
        </button>
      </div>

      <div v-if="selectedInstitutionId">
        <div
          v-for="grade in grades"
          :key="grade.id"
          class="mb-3 rounded-xl border border-slate-200"
        >
          <!-- Grade Header -->
          <div
            class="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-4 py-3 cursor-pointer"
            @click="toggleGrade(grade.id)"
          >
            <div class="flex items-center gap-3">
              <span class="text-sm font-black text-indigo-600">{{
                levelLabel(grade.level)
              }}</span>
              <span class="font-semibold text-slate-800">{{ grade.name }}</span>
              <span class="text-xs text-slate-400"
                >(orden: {{ grade.sort_order }})</span
              >
              <span
                class="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-bold"
                :class="
                  grade.active
                    ? 'bg-emerald-100 text-emerald-700'
                    : 'bg-slate-100 text-slate-500'
                "
              >
                {{ grade.active ? "Activo" : "Inactivo" }}
              </span>
            </div>
            <div class="flex items-center gap-2">
              <button
                class="ui-btn-secondary px-2 py-1 text-xs"
                @click.stop="editGrade(grade)"
              >
                Editar
              </button>
              <button
                class="ui-btn px-2 py-1 text-xs"
                @click.stop="openNewSection(grade.id)"
              >
                + Sección
              </button>
              <svg
                class="h-4 w-4 text-slate-400 transition-transform"
                :class="expandedGrade === grade.id ? 'rotate-180' : ''"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M19 9l-7 7-7-7"
                />
              </svg>
            </div>
          </div>

          <!-- Sections -->
          <div v-if="expandedGrade === grade.id" class="px-4 py-3">
            <div v-if="sections[grade.id]?.length" class="flex flex-wrap gap-2">
              <div
                v-for="sec in sections[grade.id]"
                :key="sec.id"
                class="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2"
              >
                <span class="font-bold text-slate-700"
                  >Sección {{ sec.name }}</span
                >
                <span
                  class="inline-flex rounded-full px-2 py-0.5 text-[11px] font-bold"
                  :class="
                    sec.active
                      ? 'bg-emerald-100 text-emerald-700'
                      : 'bg-slate-100 text-slate-500'
                  "
                >
                  {{ sec.active ? "✓" : "✗" }}
                </span>
                <button
                  class="text-xs text-slate-400 hover:text-indigo-600"
                  @click="editSection(sec)"
                >
                  Editar
                </button>
              </div>
            </div>
            <p v-else class="text-sm text-slate-400">
              No hay secciones. Añade una con el botón "Sección".
            </p>
          </div>
        </div>
        <p v-if="!grades.length && !loading" class="ui-empty-state">
          No hay grados para esta institución.
        </p>
      </div>
      <p v-else class="ui-empty-state">
        Selecciona una institución para ver y gestionar sus grados.
      </p>
    </section>

    <!-- ═══════════════════════════════════════════════
         TAB 3: LISTS
    ════════════════════════════════════════════════ -->
    <section v-if="activeTab === 'lists'" class="ui-card card-hover space-y-5">
      <!-- Filters -->
      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label class="ui-label">Institución</label>
          <select v-model="listInstitutionId" class="ui-select">
            <option value="">Selecciona...</option>
            <option
              v-for="inst in institutions"
              :key="inst.id"
              :value="inst.id"
            >
              {{ inst.name }}
            </option>
          </select>
        </div>
        <div>
          <label class="ui-label">Grado</label>
          <select
            v-model="listGradeId"
            class="ui-select"
            :disabled="!listInstitutionId"
          >
            <option value="">Selecciona...</option>
            <option v-for="g in listGrades" :key="g.id" :value="g.id">
              {{ g.name }}
            </option>
          </select>
        </div>
        <div>
          <label class="ui-label">Sección</label>
          <select
            v-model="listSectionId"
            class="ui-select"
            :disabled="!listGradeId"
          >
            <option value="">Selecciona...</option>
            <option v-for="s in listSections" :key="s.id" :value="s.id">
              {{ s.name }}
            </option>
          </select>
        </div>
        <div>
          <label class="ui-label">Año</label>
          <input
            v-model.number="listYear"
            type="number"
            class="ui-input"
            min="2024"
            max="2030"
          />
        </div>
      </div>

      <div class="flex gap-3">
        <button
          class="ui-btn"
          :disabled="!listSectionId || loading"
          @click="loadList"
        >
          Cargar lista
        </button>
      </div>

      <!-- No list found -->
      <div
        v-if="listSectionId && !currentList && !loading"
        class="rounded-xl border border-dashed border-slate-300 p-8 text-center"
      >
        <p class="text-slate-500">No hay lista activa para esta combinación.</p>
        <button class="ui-btn mt-4" @click="createList">
          Crear lista para {{ listYear }}
        </button>
      </div>

      <!-- List found -->
      <div v-if="currentList">
        <!-- List Header -->
        <div
          class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3"
        >
          <div class="flex items-center gap-3">
            <span class="font-bold text-slate-700">Lista {{ listYear }}</span>
            <span
              class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold"
              :class="
                currentList.active
                  ? 'bg-emerald-100 text-emerald-700'
                  : 'bg-amber-100 text-amber-700'
              "
            >
              {{ currentList.active ? "🟢 Activa en WhatsApp" : "🔴 Inactiva" }}
            </span>
          </div>
          <div class="flex gap-2">
            <button
              class="ui-btn-secondary px-3 py-2 text-sm"
              @click="toggleListActive"
            >
              {{ currentList.active ? "Desactivar" : "Activar" }}
            </button>
            <button class="ui-btn px-3 py-2 text-sm" @click="openNewItem">
              + Agregar ítem
            </button>
          </div>
        </div>

        <!-- List Items -->
        <div class="mt-4 space-y-3">
          <div
            v-for="item in listItems"
            :key="item.id"
            class="rounded-xl border border-slate-200 bg-white"
          >
            <!-- Item row -->
            <div class="flex items-center justify-between gap-3 px-4 py-3">
              <div class="flex items-center gap-3 min-w-0">
                <span
                  class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-xs font-bold text-indigo-700"
                >
                  {{ item.sort_order }}
                </span>
                <div class="min-w-0">
                  <p class="font-semibold text-slate-800 truncate">
                    {{ item.item_description }}
                  </p>
                  <p class="text-xs text-slate-400">
                    Cantidad: <strong>{{ item.qty }}</strong
                    >{{ item.notes ? ` · ${item.notes}` : "" }}
                  </p>
                </div>
              </div>
              <div class="flex shrink-0 items-center gap-2">
                <button
                  class="ui-btn-secondary px-2 py-1 text-xs"
                  @click="editItem(item)"
                >
                  Editar
                </button>
                <button
                  class="px-2 py-1 text-xs font-semibold text-rose-500 hover:text-rose-700"
                  @click="deleteItem(item.id)"
                >
                  Eliminar
                </button>
              </div>
            </div>

            <!-- Brand variants -->
            <div class="border-t border-slate-100 px-4 py-2">
              <div class="flex flex-wrap items-center gap-2">
                <span
                  class="text-xs font-bold text-slate-400 uppercase tracking-wider"
                  >Marcas:</span
                >
                <div
                  v-for="b in itemBrands[item.id]"
                  :key="b.id"
                  class="flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-0.5 text-xs text-slate-600"
                >
                  <span>{{ b.brand }}</span>
                  <button
                    class="ml-1 text-slate-300 hover:text-rose-500"
                    @click="deleteBrand(b)"
                  >
                    ×
                  </button>
                </div>
              </div>
              <p
                v-if="!itemBrands[item.id]?.length"
                class="text-xs text-amber-500 mt-1"
              >
                ⚠️ Sin marcas configuradas. Agrega al menos una marca (default).
              </p>
            </div>
          </div>
        </div>
        <p v-if="!listItems.length" class="ui-empty-state mt-4">
          La lista no tiene ítems. Agrega útiles con el botón de arriba.
        </p>
      </div>
    </section>
  </div>

  <!-- ════════════════════════════════════════
       MODALS
  ═════════════════════════════════════════ -->
  <Teleport to="body">
    <!-- Institution Modal -->
    <div
      v-if="showInstModal"
      class="fixed inset-0 z-[1000] flex items-center justify-center p-4"
    >
      <button
        class="absolute inset-0 bg-slate-900/55 backdrop-blur-sm"
        @click="showInstModal = false"
      />
      <section
        class="relative w-full max-w-md rounded-2xl border border-gray-200 bg-white p-6 shadow-2xl"
      >
        <h3 class="ui-heading">
          {{ isEditingInst ? "Editar institución" : "Nueva institución" }}
        </h3>
        <div class="mt-4 space-y-3">
          <div>
            <label class="ui-label">Nombre completo</label>
            <input
              v-model="instForm.name"
              type="text"
              class="ui-input"
              placeholder="Ej: Colegio Los Pinos"
            />
          </div>
          <div>
            <label class="ui-label"
              >Alias para WhatsApp
              <span class="text-slate-400">(opcional, más corto)</span></label
            >
            <input
              v-model="instForm.short_name"
              type="text"
              class="ui-input"
              placeholder="Ej: Los Pinos"
            />
          </div>
          <div class="flex items-center gap-2">
            <input
              id="instActive"
              v-model="instForm.active"
              type="checkbox"
              class="h-4 w-4 rounded border-slate-300 text-indigo-600"
            />
            <label for="instActive" class="text-sm font-medium text-slate-700"
              >Activa (visible en WhatsApp)</label
            >
          </div>
        </div>
        <div class="mt-5 flex justify-end gap-3">
          <button class="ui-btn-secondary" @click="showInstModal = false">
            Cancelar
          </button>
          <button
            class="ui-btn"
            :disabled="loading || !instForm.name"
            @click="saveInst"
          >
            {{ loading ? "Guardando..." : "Guardar" }}
          </button>
        </div>
      </section>
    </div>

    <!-- Grade Modal -->
    <div
      v-if="showGradeModal"
      class="fixed inset-0 z-[1000] flex items-center justify-center p-4"
    >
      <button
        class="absolute inset-0 bg-slate-900/55 backdrop-blur-sm"
        @click="showGradeModal = false"
      />
      <section
        class="relative w-full max-w-md rounded-2xl border border-gray-200 bg-white p-6 shadow-2xl"
      >
        <h3 class="ui-heading">
          {{ isEditingGrade ? "Editar grado" : "Nuevo grado" }}
        </h3>
        <div class="mt-4 space-y-3">
          <div>
            <label class="ui-label">Nivel</label>
            <select v-model="gradeForm.level" class="ui-select">
              <option value="inicial">Inicial</option>
              <option value="primaria">Primaria</option>
              <option value="secundaria">Secundaria</option>
            </select>
          </div>
          <div>
            <label class="ui-label">Nombre</label>
            <input
              v-model="gradeForm.name"
              type="text"
              class="ui-input"
              placeholder="Ej: 1er Grado, 3 Años"
            />
          </div>
          <div>
            <label class="ui-label">Orden de visualización</label>
            <input
              v-model.number="gradeForm.sort_order"
              type="number"
              class="ui-input"
              min="0"
            />
          </div>
          <div class="flex items-center gap-2">
            <input
              id="gradeActive"
              v-model="gradeForm.active"
              type="checkbox"
              class="h-4 w-4 rounded border-slate-300 text-indigo-600"
            />
            <label for="gradeActive" class="text-sm font-medium text-slate-700"
              >Activo</label
            >
          </div>
        </div>
        <div class="mt-5 flex justify-end gap-3">
          <button class="ui-btn-secondary" @click="showGradeModal = false">
            Cancelar
          </button>
          <button
            class="ui-btn"
            :disabled="loading || !gradeForm.name"
            @click="saveGrade"
          >
            {{ loading ? "Guardando..." : "Guardar" }}
          </button>
        </div>
      </section>
    </div>

    <!-- Section Modal -->
    <div
      v-if="showSectionModal"
      class="fixed inset-0 z-[1000] flex items-center justify-center p-4"
    >
      <button
        class="absolute inset-0 bg-slate-900/55 backdrop-blur-sm"
        @click="showSectionModal = false"
      />
      <section
        class="relative w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-6 shadow-2xl"
      >
        <h3 class="ui-heading">
          {{ sectionForm.id ? "Editar sección" : "Nueva sección" }}
        </h3>
        <div class="mt-4 space-y-3">
          <div>
            <label class="ui-label">Nombre de sección</label>
            <input
              v-model="sectionForm.name"
              type="text"
              class="ui-input"
              placeholder="Ej: A, B, Única"
            />
          </div>
          <div class="flex items-center gap-2">
            <input
              id="secActive"
              v-model="sectionForm.active"
              type="checkbox"
              class="h-4 w-4 rounded border-slate-300 text-indigo-600"
            />
            <label for="secActive" class="text-sm font-medium text-slate-700"
              >Activa</label
            >
          </div>
        </div>
        <div class="mt-5 flex justify-end gap-3">
          <button class="ui-btn-secondary" @click="showSectionModal = false">
            Cancelar
          </button>
          <button
            class="ui-btn"
            :disabled="loading || !sectionForm.name"
            @click="saveSection"
          >
            {{ loading ? "Guardando..." : "Guardar" }}
          </button>
        </div>
      </section>
    </div>

    <!-- List Item Modal -->
    <div
      v-if="showItemModal"
      class="fixed inset-0 z-[1000] flex items-center justify-center p-4"
    >
      <button
        class="absolute inset-0 bg-slate-900/55 backdrop-blur-sm"
        @click="showItemModal = false"
      />
      <section
        class="relative w-full max-w-md rounded-2xl border border-gray-200 bg-white p-6 shadow-2xl"
      >
        <h3 class="ui-heading">
          {{ isEditingItem ? "Editar ítem" : "Nuevo ítem de lista" }}
        </h3>
        <div class="mt-4 space-y-4">
          <!-- Product multi-select search -->
          <div>
            <label class="ui-label">Buscar producto del inventario</label>

            <!-- ── Productos ya seleccionados (siempre visible) ────────── -->
            <div
              v-if="pendingProducts.length"
              class="mb-2 rounded-xl border border-indigo-200 bg-indigo-50 divide-y divide-indigo-100"
            >
              <div class="flex items-center justify-between px-4 py-2">
                <span
                  class="text-xs font-bold uppercase tracking-wide text-indigo-600"
                >
                  ✓ {{ pendingProducts.length }} seleccionado(s)
                </span>
                <span class="text-xs text-indigo-400"
                  >El primero es la marca por defecto</span
                >
              </div>
              <label
                v-for="p in pendingProducts"
                :key="'sel-' + p.id"
                class="flex cursor-pointer items-center gap-3 px-4 py-2.5 transition hover:bg-indigo-100"
              >
                <input
                  type="checkbox"
                  class="h-4 w-4 rounded border-indigo-300 text-indigo-600"
                  checked
                  @change="removePendingProduct(p.id)"
                />
                <div class="min-w-0 flex-1">
                  <span
                    class="block truncate text-sm font-semibold text-slate-800"
                    >{{ p.name }}</span
                  >
                  <span v-if="p.brand" class="text-xs text-slate-400">{{
                    p.brand
                  }}</span>
                </div>
                <button
                  type="button"
                  class="shrink-0 text-xs text-red-400 hover:text-red-600"
                  @click.prevent="removePendingProduct(p.id)"
                >
                  ✕
                </button>
              </label>
            </div>

            <input
              v-model="itemDescSearch"
              type="text"
              class="ui-input"
              placeholder="Ej: cuaderno 100h, cuadrimax, lápiz 2B..."
              @input="searchItemProducts"
            />

            <!-- Multi-select list (stays open) -->
            <div
              v-if="itemDescResults.length || itemSearchLoading"
              class="mt-1 max-h-64 overflow-y-auto rounded-xl border border-gray-200 bg-white shadow-sm"
            >
              <div
                v-if="itemSearchLoading"
                class="flex items-center justify-center py-4"
              >
                <svg
                  class="h-5 w-5 animate-spin text-indigo-400"
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
                  />
                  <path
                    class="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                  />
                </svg>
              </div>
              <label
                v-for="p in itemDescResults"
                :key="p.id"
                class="flex cursor-pointer items-center gap-3 px-4 py-2.5 transition hover:bg-indigo-50"
                :class="
                  pendingProducts.find((pp) => pp.id === p.id)
                    ? 'bg-indigo-50'
                    : ''
                "
              >
                <input
                  type="checkbox"
                  class="h-4 w-4 rounded border-slate-300 text-indigo-600"
                  :checked="!!pendingProducts.find((pp) => pp.id === p.id)"
                  @change="
                    pendingProducts.find((pp) => pp.id === p.id)
                      ? removePendingProduct(p.id)
                      : addProductToItem(p)
                  "
                />
                <div class="min-w-0 flex-1">
                  <span
                    class="block truncate text-sm font-semibold text-slate-800"
                    >{{ p.name }}</span
                  >
                  <span v-if="p.brand" class="text-xs text-slate-400">{{
                    p.brand
                  }}</span>
                </div>
                <span class="shrink-0 text-xs font-bold text-emerald-600"
                  >S/ {{ p.sale_price }}</span
                >
              </label>
            </div>

            <p
              v-if="!pendingProducts.length && itemDescResults.length"
              class="mt-1.5 text-xs text-slate-400"
            >
              Selecciona uno o más para vincular sus marcas automáticamente.
            </p>
          </div>

          <!-- Description (editable, auto-filled by first product) -->
          <div>
            <label class="ui-label"
              >Descripción del útil
              <span class="text-slate-400">(editable)</span></label
            >
            <input
              v-model="itemForm.item_description"
              type="text"
              class="ui-input"
              placeholder="Ej: Cuaderno rayado A4 – se llena automáticamente"
            />
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="ui-label">Cantidad</label>
              <input
                v-model.number="itemForm.qty"
                type="number"
                class="ui-input"
                min="1"
              />
            </div>
            <div>
              <label class="ui-label">Orden</label>
              <input
                v-model.number="itemForm.sort_order"
                type="number"
                class="ui-input"
                min="0"
              />
            </div>
          </div>

          <div>
            <label class="ui-label"
              >Notas <span class="text-slate-400">(opcional)</span></label
            >
            <input
              v-model="itemForm.notes"
              type="text"
              class="ui-input"
              placeholder="Ej: Con espiral, 100 hojas"
            />
          </div>
        </div>
        <div class="mt-5 flex justify-end gap-3">
          <button class="ui-btn-secondary" @click="showItemModal = false">
            Cancelar
          </button>
          <button
            class="ui-btn"
            :disabled="loading || !itemForm.item_description"
            @click="saveItem"
          >
            {{
              loading
                ? "Guardando..."
                : pendingProducts.length
                  ? `Guardar + ${pendingProducts.length} marca(s)`
                  : "Guardar"
            }}
          </button>
        </div>
      </section>
    </div>
  </Teleport>
</template>
