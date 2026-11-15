// Builds the create_sale migration "manual price for any role" FROM THE REAL DEFINITION of the
// database, never from supabase/schema.sql (which may be out of date).
//
// 1. Read the real definition (read only), e.g. in the Supabase SQL editor:
//      select pg_get_functiondef('public.create_sale(uuid,text,jsonb)'::regprocedure);
//    and save the result as a .sql file.
// 2. node scripts/create-sale-manual-price-migration.mjs <real-definition.sql> [--out <dir>]
//
// It writes, without touching any database:
//   <out>/migrations/20261115_create_sale_manual_price_any_role.sql   (the change)
//   <out>/rollbacks/20261115_create_sale_manual_price_any_role_down.sql (EXACTLY the real definition)
// and fails if the permission block is not found exactly once, or if anything else would change.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const [input, ...rest] = process.argv.slice(2)
if (!input) {
  console.error('Uso: node scripts/create-sale-manual-price-migration.mjs <definicion-real.sql> [--out <dir>]')
  process.exit(2)
}
const outIndex = rest.indexOf('--out')
const out = resolve(outIndex >= 0 ? rest[outIndex + 1] : join(fileURLToPath(new URL('..', import.meta.url)), 'supabase'))
const NAME = '20261115_create_sale_manual_price_any_role'

const real = readFileSync(input, 'utf8').replace(/\s*;?\s*$/, '')
if (!/create\s+or\s+replace\s+function\s+public\.create_sale\s*\(\s*p_customer_id\s+uuid\s*,\s*p_payment_method\s+text\s*,\s*p_items\s+jsonb\s*\)/i.test(real)) {
  throw new Error('La entrada no es la definición de public.create_sale(uuid, text, jsonb).')
}

// The one block that changes: role check + mandatory reason, shared by discounts and manual price.
const block = new RegExp(
  String.raw`(?<indent>[ \t]*)if\s*\(\s*v_manual_discount_pct\s*>\s*0\s+or\s+v_manual_discount_amount\s*>\s*0\s+` +
  String.raw`or\s+\(\s*v_price_input\s+is\s+not\s+null\s+and\s+abs\(\s*v_price_input\s*-\s*v_auto_price_uom\s*\)\s*>\s*0\.0001\s*\)\s*\)\s*then\s+` +
  String.raw`if\s+not\s+v_can_manual_discount\s+then\s+raise\s+exception\s+'[^']*'\s*;\s*end\s+if\s*;\s+` +
  String.raw`if\s+v_manual_discount_reason\s+is\s+null\s+then\s+raise\s+exception\s+'(?<reason>[^']*)'\s*;\s*end\s+if\s*;\s+end\s+if\s*;`,
  'gi'
)
const matches = [...real.matchAll(block)]
if (matches.length !== 1) {
  throw new Error(`Se esperaba el bloque de permisos exactamente 1 vez y aparece ${matches.length}. La definición real difiere del repo: revisar a mano, no adivinar.`)
}
const { indent, reason } = matches[0].groups
const i = indent
const replacement = [
  `${i}-- Descuentos (porcentaje o monto): solo owner/manager.`,
  `${i}if (v_manual_discount_pct > 0 or v_manual_discount_amount > 0) and not v_can_manual_discount then`,
  `${i}  raise exception 'Tu rol no permite descuentos manuales';`,
  `${i}end if;`,
  ``,
  `${i}-- Precio manual (price_unit distinto al automático): cualquier rol que pueda registrar ventas`,
  `${i}-- (decisión del dueño, 2026-11-15). El motivo sigue siendo obligatorio para descuentos y precio manual.`,
  `${i}if (`,
  `${i}  v_manual_discount_pct > 0`,
  `${i}  or v_manual_discount_amount > 0`,
  `${i}  or (v_price_input is not null and abs(v_price_input - v_auto_price_uom) > 0.0001)`,
  `${i}) then`,
  `${i}  if v_manual_discount_reason is null then`,
  `${i}    raise exception '${reason}';`,
  `${i}  end if;`,
  `${i}end if;`
].join('\n')
const changed = real.slice(0, matches[0].index) + replacement + real.slice(matches[0].index + matches[0][0].length)

// Safety: outside the block, the function must be byte-for-byte identical.
const before = real.slice(0, matches[0].index) + real.slice(matches[0].index + matches[0][0].length)
const after = changed.slice(0, matches[0].index) + changed.slice(matches[0].index + replacement.length)
if (before !== after) throw new Error('El cambio tocaría algo fuera del bloque de permisos.')

const header = (title) => [
  `-- ${title}`,
  `-- Generado por scripts/create-sale-manual-price-migration.mjs a partir de la definición REAL`,
  `-- (pg_get_functiondef). Solo toca public.create_sale; no modifica datos. Idempotente (CREATE OR REPLACE).`,
  `-- La firma no cambia: se conservan el dueño, SECURITY DEFINER, search_path y los GRANT existentes.`,
  ''
].join('\n')
mkdirSync(join(out, 'migrations'), { recursive: true })
mkdirSync(join(out, 'rollbacks'), { recursive: true })
const migration = join(out, 'migrations', `${NAME}.sql`)
const rollback = join(out, 'rollbacks', `${NAME}_down.sql`)
writeFileSync(migration, `${header('create_sale: precio manual permitido a cualquier rol; descuentos solo owner/manager')}begin;\n\n${changed};\n\ncommit;\n`)
writeFileSync(rollback, `${header('ROLLBACK: restaura EXACTAMENTE la definición real previa de create_sale')}begin;\n\n${real};\n\ncommit;\n`)
console.log(`Bloque encontrado 1 vez; nada más cambia.\n  ${migration}\n  ${rollback}`)
