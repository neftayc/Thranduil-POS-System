-- Migration: school_lists (final schema)
-- Created at: 2026-02-23

-- ===========================
-- 1. Institutions (Colegios)
-- ===========================
CREATE TABLE IF NOT EXISTS institutions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    short_name TEXT,      -- alias corto para menús WhatsApp
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE institutions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role can do all on institutions"
ON institutions FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ===========================
-- 2. School Grades (Grados)
-- ===========================
CREATE TABLE IF NOT EXISTS school_grades (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    level TEXT NOT NULL CHECK (level IN ('inicial', 'primaria', 'secundaria')),
    name TEXT NOT NULL,   -- "3 Años", "1er Grado", "2do Grado"…
    sort_order INT NOT NULL DEFAULT 0,
    active BOOLEAN NOT NULL DEFAULT true
);

ALTER TABLE school_grades ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role can do all on school_grades"
ON school_grades FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ===========================
-- 3. Sections (Secciones)
-- ===========================
CREATE TABLE IF NOT EXISTS school_sections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    grade_id UUID NOT NULL REFERENCES school_grades(id) ON DELETE CASCADE,
    name TEXT NOT NULL,   -- "A", "B", "Única"
    active BOOLEAN NOT NULL DEFAULT true
);

ALTER TABLE school_sections ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role can do all on school_sections"
ON school_sections FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ===========================
-- 4. School Lists (una por sección/año)
-- ===========================
CREATE TABLE IF NOT EXISTS school_lists (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    grade_id UUID NOT NULL REFERENCES school_grades(id) ON DELETE CASCADE,
    section_id UUID NOT NULL REFERENCES school_sections(id) ON DELETE CASCADE,
    year INT NOT NULL DEFAULT EXTRACT(YEAR FROM NOW()),
    active BOOLEAN NOT NULL DEFAULT true,  -- solo listas activas aparecen en WhatsApp
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (institution_id, grade_id, section_id, year)
);

ALTER TABLE school_lists ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role can do all on school_lists"
ON school_lists FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ===========================
-- 5. School List Items (ítems de cada lista)
-- ===========================
CREATE TABLE IF NOT EXISTS school_list_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    list_id UUID NOT NULL REFERENCES school_lists(id) ON DELETE CASCADE,
    item_description TEXT NOT NULL,  -- "Cuaderno rayado A4", "Regla 30cm"
    qty INT NOT NULL DEFAULT 1,
    notes TEXT,
    sort_order INT NOT NULL DEFAULT 0
);

ALTER TABLE school_list_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role can do all on school_list_items"
ON school_list_items FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ===========================
-- 6. School List Item Brands (variantes por marca de cada ítem)
--    El admin vincula: ítem X → Producto A (Faber Castell), Producto B (Artesco)…
-- ===========================
CREATE TABLE IF NOT EXISTS school_list_item_brands (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id UUID NOT NULL REFERENCES school_list_items(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    brand TEXT NOT NULL,            -- "Faber Castell", "Artesco", "Norma"
    is_default BOOLEAN NOT NULL DEFAULT false  -- fallback si ninguna marca preferida está disponible
);

ALTER TABLE school_list_item_brands ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role can do all on school_list_item_brands"
ON school_list_item_brands FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ===========================
-- 7. Add school_selection column to whatsapp_sessions
-- ===========================
ALTER TABLE whatsapp_sessions
    ADD COLUMN IF NOT EXISTS school_selection JSONB DEFAULT '{}'::jsonb;
