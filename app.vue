<script setup lang="ts">
const route = useRoute();

type NavGroup = "operacion" | "gestion";
type NavItem = {
  to: string;
  label: string;
  hint: string;
  group: NavGroup;
};

const brandName = "THRANDUIL";

const userEmail = ref("");
const userRole = ref("");
const mobileMenuOpen = ref(false);
const settingsOpen = ref(false);
const accountMenuOpen = ref(false);
const accountMenuRef = ref<HTMLElement | null>(null);
const sidebarCollapsed = ref(false);

const SIDEBAR_STORAGE_KEY = "thranduil_sidebar_collapsed_v1";

const { themes, activeTheme, setTheme, initTheme } = useTheme();

const navItems = computed<NavItem[]>(() => {
  const base: NavItem[] = [
    {
      to: "/",
      label: "Dashboard",
      hint: "Resumen del negocio",
      group: "operacion",
    },
    {
      to: "/sales",
      label: "Caja y TPV",
      hint: "Venta directa en caja",
      group: "operacion",
    },
    {
      to: "/utiles",
      label: "Útiles",
      hint: "Pedidos escolares inteligentes",
      group: "operacion",
    },
    {
      to: "/stock-ai",
      label: "Compra Escolar",
      hint: "Reporte de compra urgente por stock",
      group: "operacion",
    },
    {
      to: "/combos",
      label: "Combos",
      hint: "Planifica combos por stock",
      group: "operacion",
    },
    {
      to: "/purchases",
      label: "Compras",
      hint: "Ingreso de mercaderia",
      group: "operacion",
    },
    {
      to: "/inventory",
      label: "Inventario",
      hint: "Control de stock",
      group: "operacion",
    },
    {
      to: "/products",
      label: "Productos",
      hint: "Catalogo y precios",
      group: "operacion",
    },
    {
      to: "/customers",
      label: "Clientes",
      hint: "Base comercial",
      group: "gestion",
    },
    {
      to: "/suppliers",
      label: "Proveedores",
      hint: "Contactos de compra",
      group: "gestion",
    },
  ];

  if (userRole.value === "owner") {
    base.push({
      to: "/product-profitability",
      label: "Rentabilidad",
      hint: "Compras y ventas por producto",
      group: "gestion",
    });
    base.push({
      to: "/pricing",
      label: "Reglas de venta",
      hint: "Mayorista y promos",
      group: "gestion",
    });
    base.push({
      to: "/school-lists",
      label: "Listas Escolares",
      hint: "Colegios, grados y útiles",
      group: "gestion",
    });
    base.push({
      to: "/maintenance",
      label: "Mantenimiento",
      hint: "Variables globales",
      group: "gestion",
    });
    base.push({
      to: "/users",
      label: "Usuarios",
      hint: "Roles y accesos",
      group: "gestion",
    });
  }

  return base;
});

const operationItems = computed(() =>
  navItems.value.filter((item) => item.group === "operacion"),
);
const managementItems = computed(() =>
  navItems.value.filter((item) => item.group === "gestion"),
);

const activeNavItem = computed(() =>
  navItems.value.find((item) => item.to === route.path),
);
const currentPage = computed(() => activeNavItem.value?.label || "Dashboard");
const currentHint = computed(
  () => activeNavItem.value?.hint || "Panel principal de operacion diaria",
);
const headerTitle = computed(() =>
  route.path === "/sales" ? "Punto de Venta 🛒" : currentPage.value,
);
const headerSubtitle = computed(() =>
  route.path === "/sales"
    ? "Crea nuevas órdenes y gestiona cobros."
    : currentHint.value,
);

const roleLabel = computed(() => {
  if (!userRole.value) return "Sin rol";
  if (userRole.value === "owner") return "Propietario";
  if (userRole.value === "manager") return "Encargado";
  return "Cajero";
});

const todayLabel = computed(() =>
  new Intl.DateTimeFormat("es-PE", {
    weekday: "long",
    day: "2-digit",
    month: "short",
  }).format(new Date()),
);

const userInitials = computed(() => {
  if (!userEmail.value) return "SN";
  const username = userEmail.value.split("@")[0] || "";
  return username.slice(0, 2).toUpperCase() || "US";
});

const isLoginPage = computed(() => route.path === "/login");
const isSalesPage = computed(() => route.path === "/sales");
const salesView = computed(() => {
  const raw = String(route.query.view || "")
    .toLowerCase()
    .trim();
  if (raw === "checkout" || raw === "pedidos") return "checkout";
  if (raw === "history" || raw === "historial") return "history";
  if (raw === "reports" || raw === "reportes") return "reports";
  return "pos";
});
const salesPrimaryCtaLabel = computed(() =>
  isSalesPage.value && salesView.value !== "pos"
    ? "Regresar a venta actual"
    : "Nueva Venta",
);
const salesPrimaryCtaTo = computed(() => ({
  path: "/sales",
  query: { view: "pos" },
}));

const isActiveRoute = (to: string) => route.path === to;

const navItemClass = (to: string) =>
  isActiveRoute(to)
    ? "ui-nav-link sidebar-item-active flex items-center gap-3"
    : "ui-nav-link sidebar-item-inactive flex items-center gap-3";

const desktopNavItemClass = (to: string) => [
  navItemClass(to),
  sidebarCollapsed.value ? "justify-center !px-0" : "",
];

const navIcon = (to: string) => {
  if (to === "/")
    return "M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z";
  if (to === "/inventory")
    return "M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m-8-14l8 4m-8-4v10l8 4m0-10V3";
  if (to === "/sales")
    return "M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z";
  if (to === "/utiles")
    return "M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9zM9 9h6";
  if (to === "/stock-ai")
    return "M9 17v-6m3 6V7m3 10V4m-7 16h8a2 2 0 002-2V6a2 2 0 00-2-2h-8a2 2 0 00-2 2v12a2 2 0 002 2z";
  if (to === "/combos")
    return "M3 7h18M5 7l1 12h12l1-12M9 11h6M10 15h4M9 7V5a3 3 0 016 0v2";
  if (to === "/customers")
    return "M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z";
  if (to === "/school-lists")
    return "M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253";
  if (to === "/product-profitability")
    return "M3 3v18h18M7 15l3-3 3 2 4-5";
  return "M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z";
};

const themeCardClass = (themeId: string) =>
  activeTheme.value === themeId
    ? "border-indigo-500 bg-indigo-50/70 shadow-md shadow-indigo-500/10"
    : "border-gray-200 bg-white hover:border-indigo-300 hover:bg-indigo-50/30";

const toggleAccountMenu = () => {
  accountMenuOpen.value = !accountMenuOpen.value;
};

const toggleSidebar = () => {
  sidebarCollapsed.value = !sidebarCollapsed.value;
};

const openSettings = () => {
  mobileMenuOpen.value = false;
  accountMenuOpen.value = false;
  settingsOpen.value = true;
};

const loadSession = async () => {
  try {
    const { user, role } = await $fetch<{
      user: { email: string | null };
      role: string;
    }>("/api/auth/me");
    userEmail.value = user?.email || "";
    userRole.value = role || "";
  } catch {
    userEmail.value = "";
    userRole.value = "";
  }
};

const signOut = async () => {
  accountMenuOpen.value = false;
  await $fetch("/api/auth/sign-out", { method: "POST" });
  await navigateTo("/login");
};

const handleDocumentClick = (event: MouseEvent) => {
  const target = event.target as Node | null;
  if (!target) return;
  if (accountMenuRef.value && !accountMenuRef.value.contains(target)) {
    accountMenuOpen.value = false;
  }
};

watch(
  () => route.fullPath,
  () => {
    mobileMenuOpen.value = false;
    settingsOpen.value = false;
    accountMenuOpen.value = false;
  },
);

watch(sidebarCollapsed, (collapsed) => {
  if (!import.meta.client) return;
  localStorage.setItem(SIDEBAR_STORAGE_KEY, collapsed ? "1" : "0");
});

watch(
  () => route.path,
  (path) => {
    if (path === "/login") return;
    loadSession();
  },
  { immediate: true },
);

onMounted(() => {
  initTheme();

  if (import.meta.client) {
    sidebarCollapsed.value = localStorage.getItem(SIDEBAR_STORAGE_KEY) === "1";
    document.addEventListener("click", handleDocumentClick);
  }
});

onBeforeUnmount(() => {
  if (import.meta.client) {
    document.removeEventListener("click", handleDocumentClick);
  }
});
</script>

<template>
  <div
    v-if="isLoginPage"
    class="min-h-screen bg-slate-50 px-4 py-8 sm:px-6 lg:px-8"
  >
    <NuxtPage />
  </div>

  <div v-else class="flex h-screen overflow-hidden bg-slate-50 text-slate-800">
    <aside
      class="relative hidden shrink-0 border-r border-slate-800 bg-slate-900 shadow-xl transition-all duration-300 xl:flex xl:flex-col"
      :class="sidebarCollapsed ? 'w-24' : 'w-72'"
    >
      <button
        class="absolute -right-3 top-7 z-20 hidden h-7 w-7 items-center justify-center rounded-full border border-slate-700 bg-slate-900 text-slate-300 shadow-lg transition hover:border-indigo-400 hover:text-white xl:inline-flex"
        :title="sidebarCollapsed ? 'Expandir menu' : 'Minimizar menu'"
        @click="toggleSidebar"
      >
        <svg
          class="h-4 w-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            :d="sidebarCollapsed ? 'M9 5l7 7-7 7' : 'M15 19l-7-7 7-7'"
          />
        </svg>
      </button>

      <div
        class="h-24 flex items-center"
        :class="sidebarCollapsed ? 'justify-center px-3' : 'px-8'"
      >
        <div class="flex items-center gap-3">
          <div
            class="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-600 shadow-lg shadow-indigo-900/50"
          >
            <svg
              class="h-6 w-6 text-white"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2.5"
                d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
              />
            </svg>
          </div>
          <div v-if="!sidebarCollapsed">
            <span
              class="block leading-none text-lg font-extrabold tracking-tight text-white"
              >{{ brandName }}</span
            >
            <span
              class="text-xs font-bold uppercase tracking-widest text-indigo-400"
              >Manager</span
            >
          </div>
        </div>
      </div>

      <nav
        class="flex-1 py-4 space-y-2"
        :class="[
          sidebarCollapsed ? 'px-2 overflow-y-hidden' : 'px-6 overflow-y-auto',
        ]"
      >
        <p
          v-if="!sidebarCollapsed"
          class="px-2 pb-2 text-[11px] font-extrabold uppercase tracking-widest text-slate-500"
        >
          Principal
        </p>
        <NuxtLink
          v-for="item in operationItems"
          :key="item.to"
          :to="item.to"
          :class="desktopNavItemClass(item.to)"
          :title="sidebarCollapsed ? item.label : undefined"
        >
          <svg
            class="h-5 w-5 shrink-0"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              :d="navIcon(item.to)"
            />
          </svg>
          <span v-if="!sidebarCollapsed" class="truncate">{{
            item.label
          }}</span>
        </NuxtLink>

        <template v-if="managementItems.length">
          <p
            v-if="!sidebarCollapsed"
            class="px-2 pt-6 pb-2 text-[11px] font-extrabold uppercase tracking-widest text-slate-500"
          >
            Gestion
          </p>
          <NuxtLink
            v-for="item in managementItems"
            :key="item.to"
            :to="item.to"
            :class="desktopNavItemClass(item.to)"
            :title="sidebarCollapsed ? item.label : undefined"
          >
            <svg
              class="h-5 w-5 shrink-0"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                :d="navIcon(item.to)"
              />
            </svg>
            <span v-if="!sidebarCollapsed" class="truncate">{{
              item.label
            }}</span>
          </NuxtLink>
        </template>
      </nav>

      <div class="p-6" :class="sidebarCollapsed ? 'flex justify-center' : ''">
        <button
          v-if="!sidebarCollapsed"
          class="w-full ui-btn-secondary !justify-center"
          @click="openSettings"
        >
          Ajustes visuales
        </button>
        <button
          v-else
          class="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-700 bg-slate-800 text-slate-300 transition hover:border-indigo-400 hover:text-white"
          title="Ajustes visuales"
          @click="openSettings"
        >
          <svg
            class="h-5 w-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M12 15.5A3.5 3.5 0 1012 8.5a3.5 3.5 0 000 7z"
            />
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M19.4 15a1.7 1.7 0 00.34 1.87l.06.06a2 2 0 11-2.83 2.83l-.06-.06A1.7 1.7 0 0015 19.4a1.7 1.7 0 00-1 .6 1.7 1.7 0 00-.4 1.06V21a2 2 0 11-4 0v-.09a1.7 1.7 0 00-.4-1.06 1.7 1.7 0 00-1-.6 1.7 1.7 0 00-1.87.34l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.7 1.7 0 004.6 15a1.7 1.7 0 00-.6-1 1.7 1.7 0 00-1.06-.4H2.9a2 2 0 110-4h.09a1.7 1.7 0 001.06-.4 1.7 1.7 0 00.6-1 1.7 1.7 0 00-.34-1.87l-.06-.06a2 2 0 112.83-2.83l.06.06A1.7 1.7 0 009 4.6c.37 0 .73-.13 1-.37A1.7 1.7 0 0010.4 3.2V3.1a2 2 0 114 0v.09c0 .4.14.78.4 1.06.27.24.63.37 1 .37a1.7 1.7 0 001.87-.34l.06-.06a2 2 0 112.83 2.83l-.06.06A1.7 1.7 0 0019.4 9c0 .37.13.73.37 1 .28.26.66.4 1.06.4h.09a2 2 0 110 4h-.09c-.4 0-.78.14-1.06.4-.24.27-.37.63-.37 1z"
            />
          </svg>
        </button>
      </div>
    </aside>

    <section
      class="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-slate-50"
    >
      <div
        class="pointer-events-none absolute top-0 left-0 h-64 w-full bg-gradient-to-b from-white to-transparent"
      />

      <header class="ui-topbar relative z-10">
        <div class="min-w-0">
          <p
            v-if="!isSalesPage"
            class="text-[11px] font-extrabold uppercase tracking-widest text-slate-500"
          >
            {{ todayLabel }}
          </p>
          <h1 class="mt-0.5 truncate text-2xl font-black text-slate-800">
            {{ headerTitle }}
          </h1>
          <p class="truncate text-sm font-medium text-slate-500">
            {{ headerSubtitle }}
          </p>
        </div>

        <div class="flex items-center gap-3">
          <button
            class="ui-btn-secondary xl:hidden"
            @click="mobileMenuOpen = true"
          >
            Menu
          </button>

          <div v-if="!isSalesPage" class="relative hidden md:block">
            <input
              type="text"
              placeholder="Buscar general..."
              class="ui-input w-64 pl-10"
            />
            <svg
              class="absolute left-3 top-3 h-5 w-5 text-gray-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
          </div>

          <NuxtLink
            v-if="isSalesPage"
            :to="{ path: '/sales', query: { view: 'history' } }"
            class="hidden h-12 px-7 ui-btn-secondary md:inline-flex"
          >
            Ver historial de ventas
          </NuxtLink>

          <NuxtLink
            v-if="isSalesPage"
            :to="{ path: '/sales', query: { view: 'checkout' } }"
            class="relative hidden h-12 w-12 items-center justify-center rounded-xl border border-gray-200 bg-white text-slate-400 shadow-sm transition-all hover:border-indigo-200 hover:text-indigo-600 md:inline-flex"
            title="Ver pedidos"
          >
            <svg
              class="h-6 w-6"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
              />
            </svg>
            <span
              class="absolute top-3 right-3 h-2 w-2 rounded-full border border-white bg-rose-500"
            />
          </NuxtLink>

          <button
            v-else
            class="relative hidden h-12 w-12 items-center justify-center rounded-xl border border-gray-200 bg-white text-slate-400 shadow-sm transition-all hover:border-indigo-200 hover:text-indigo-600 md:inline-flex"
          >
            <svg
              class="h-6 w-6"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
              />
            </svg>
            <span
              class="absolute top-3 right-3 h-2 w-2 rounded-full border border-white bg-rose-500"
            />
          </button>

          <NuxtLink
            :to="salesPrimaryCtaTo"
            class="hidden h-12 ui-btn sm:inline-flex"
          >
            <span class="text-lg leading-none">+</span>
            <span>{{ salesPrimaryCtaLabel }}</span>
          </NuxtLink>

          <div v-if="!isSalesPage" ref="accountMenuRef" class="relative">
            <button class="ui-account-trigger" @click.stop="toggleAccountMenu">
              <span class="ui-user-avatar">{{ userInitials }}</span>
              <span
                class="hidden max-w-[220px] truncate text-sm font-bold text-slate-600 lg:block"
              >
                {{ userEmail || "Sin sesion" }}
              </span>
            </button>

            <transition
              enter-active-class="transition duration-150"
              enter-from-class="opacity-0 -translate-y-1"
              enter-to-class="opacity-100 translate-y-0"
              leave-active-class="transition duration-100"
              leave-from-class="opacity-100 translate-y-0"
              leave-to-class="opacity-0 -translate-y-1"
            >
              <div v-if="accountMenuOpen" class="ui-account-menu">
                <p class="truncate text-sm font-bold text-slate-800">
                  {{ userEmail || "Sin sesion" }}
                </p>
                <p class="mt-0.5 text-xs font-medium text-slate-500">
                  {{ roleLabel }}
                </p>
                <div class="mt-3 space-y-1.5 border-t border-gray-100 pt-3">
                  <button class="ui-account-menu-item" @click="openSettings">
                    Preferencias visuales
                  </button>
                  <button
                    class="ui-account-menu-item text-rose-500 hover:text-rose-600"
                    @click="signOut"
                  >
                    Cerrar sesion
                  </button>
                </div>
              </div>
            </transition>
          </div>
        </div>
      </header>

      <main
        class="relative z-10 flex-1 p-4 sm:p-6 lg:p-8"
        :class="isSalesPage ? 'overflow-hidden' : 'overflow-y-auto'"
      >
        <div
          class="mx-auto w-full max-w-[1600px]"
          :class="isSalesPage ? 'h-full min-h-0' : ''"
        >
          <NuxtPage />
        </div>
      </main>
    </section>

    <transition
      enter-active-class="transition duration-200"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition duration-150"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div v-if="mobileMenuOpen" class="fixed inset-0 z-50 xl:hidden">
        <button
          class="absolute inset-0 bg-slate-900/70"
          aria-label="Cerrar menu"
          @click="mobileMenuOpen = false"
        />
        <aside
          class="absolute inset-y-0 left-0 w-[86%] max-w-sm overflow-y-auto border-r border-slate-800 bg-slate-900 p-6"
        >
          <div class="h-16 flex items-center">
            <div>
              <p class="text-lg font-extrabold text-white">{{ brandName }}</p>
              <p
                class="text-xs font-bold uppercase tracking-widest text-indigo-400"
              >
                Manager
              </p>
            </div>
          </div>

          <p
            class="mt-4 px-2 pb-2 text-[11px] font-extrabold uppercase tracking-widest text-slate-500"
          >
            Principal
          </p>
          <nav class="space-y-2">
            <NuxtLink
              v-for="item in operationItems"
              :key="item.to"
              :to="item.to"
              :class="navItemClass(item.to)"
            >
              <svg
                class="h-5 w-5 shrink-0"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  :d="navIcon(item.to)"
                />
              </svg>
              <span class="truncate">{{ item.label }}</span>
            </NuxtLink>
          </nav>

          <template v-if="managementItems.length">
            <p
              class="mt-6 px-2 pb-2 text-[11px] font-extrabold uppercase tracking-widest text-slate-500"
            >
              Gestion
            </p>
            <nav class="space-y-2">
              <NuxtLink
                v-for="item in managementItems"
                :key="item.to"
                :to="item.to"
                :class="navItemClass(item.to)"
              >
                <svg
                  class="h-5 w-5 shrink-0"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    :d="navIcon(item.to)"
                  />
                </svg>
                <span class="truncate">{{ item.label }}</span>
              </NuxtLink>
            </nav>
          </template>
        </aside>
      </div>
    </transition>

    <transition
      enter-active-class="transition duration-200"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition duration-150"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div v-if="settingsOpen" class="fixed inset-0 z-[60]">
        <button
          class="absolute inset-0 bg-slate-900/55"
          aria-label="Cerrar ajustes"
          @click="settingsOpen = false"
        />

        <aside
          class="absolute inset-y-0 right-0 w-full max-w-xl overflow-y-auto border-l border-gray-200 bg-white p-5 shadow-2xl"
        >
          <div class="flex items-start justify-between gap-3">
            <div>
              <p
                class="text-xs font-bold uppercase tracking-[0.16em] text-slate-500"
              >
                Preferencias
              </p>
              <h3 class="mt-1 text-xl font-display text-slate-800">
                Temas de interfaz
              </h3>
              <p class="mt-2 text-sm text-slate-500">
                Aplica una direccion visual distinta para toda la aplicacion.
              </p>
            </div>
            <button
              class="ui-btn-secondary px-3 py-2"
              @click="settingsOpen = false"
            >
              Cerrar
            </button>
          </div>

          <div class="mt-5 grid gap-3 sm:grid-cols-2">
            <button
              v-for="theme in themes"
              :key="theme.id"
              class="rounded-2xl border p-4 text-left transition"
              :class="themeCardClass(theme.id)"
              @click="setTheme(theme.id)"
            >
              <div class="flex items-start justify-between gap-3">
                <div>
                  <p class="text-sm font-semibold text-slate-800">
                    {{ theme.name }}
                  </p>
                  <p class="mt-1 text-xs text-slate-500">
                    {{ theme.description }}
                  </p>
                </div>
                <span
                  class="rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide"
                  :class="
                    activeTheme === theme.id
                      ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                      : 'border-gray-200 text-slate-500'
                  "
                >
                  {{ activeTheme === theme.id ? "Activo" : "Aplicar" }}
                </span>
              </div>

              <div class="mt-3 flex items-center gap-2">
                <span
                  v-for="(swatch, idx) in theme.swatches"
                  :key="`${theme.id}-${idx}`"
                  class="h-6 w-6 rounded-full border border-white/20"
                  :style="{ backgroundColor: swatch }"
                />
              </div>
            </button>
          </div>

          <div
            class="mt-5 rounded-xl border border-gray-200 bg-slate-50 p-3 text-xs text-slate-500"
          >
            El tema seleccionado se guarda localmente para este navegador.
          </div>
        </aside>
      </div>
    </transition>
  </div>
</template>
