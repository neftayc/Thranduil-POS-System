import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

// Sale attribution (owner, 2026-11-16): sold_by = seller, approved_by = reviewer.
// 1) The executor only sends p_sold_by / p_approved_by when present (the agent's direct sale is unchanged).
// 2) The migration, run for real on a THROWAWAY local Postgres (never Supabase): create_sale keeps working
//    with its 3 old parameters, validates the new ones, and the rollback restores the old signature.
const requireNuxt = createRequire(import.meta.resolve('nuxt/package.json'))
const { createJiti } = requireNuxt('jiti')
const jiti = createJiti(import.meta.url)
const { makeSupabaseSaleExecutor } = await jiti.import('../server/modules/agent/infra/supabaseSaleExecutor.ts')
const { SaleRejectedByPosError } = await jiti.import('../server/modules/agent/contracts.ts')

const SELLER = '11111111-1111-4111-8111-111111111111'
const OWNER = '22222222-2222-4222-8222-222222222222'
const draft = (extra = {}) => ({
  customer_id: null, payment_method: 'efectivo', currency: 'PEN', total: 12,
  items: [{ product_id: 'p1', name: 'Cuaderno', qty: 2, unit_name: 'unidad', price_unit: 6, factor: 1, total: 12, list_price: 5, manual_reason: 'Precio dictado' }],
  ...extra
})
const recorder = answers => {
  const calls = []
  return { calls, rpc: async (_token, args) => { calls.push(args); return answers.shift() } }
}

test('executor: sin atribución envía exactamente los 3 parámetros de siempre', async () => {
  const r = recorder([{ data: 'sale-1', error: null }])
  await makeSupabaseSaleExecutor(async () => 'tok', r.rpc)(draft(), async () => {})
  assert.deepEqual(Object.keys(r.calls[0]).sort(), ['p_customer_id', 'p_items', 'p_payment_method'])
})

test('executor: con atribución envía p_sold_by y p_approved_by', async () => {
  const r = recorder([{ data: 'sale-1', error: null }])
  const out = await makeSupabaseSaleExecutor(async () => 'tok', r.rpc)(draft({ sold_by: SELLER, approved_by: OWNER }), async () => {})
  assert.equal(out.saleId, 'sale-1')
  assert.equal(r.calls.length, 1)
  assert.equal(r.calls[0].p_sold_by, SELLER)
  assert.equal(r.calls[0].p_approved_by, OWNER)
})

test('executor: sin la migración (PGRST202) registra sin atribución y lo deja en el log; otro error no reintenta', async () => {
  const logs = []
  const r = recorder([{ data: null, error: { code: 'PGRST202', message: 'no function' } }, { data: 'sale-2', error: null }])
  const out = await makeSupabaseSaleExecutor(async () => 'tok', r.rpc, { log: (m, d) => logs.push([m, d]) })(draft({ sold_by: SELLER, approved_by: OWNER }), async () => {})
  assert.equal(out.saleId, 'sale-2')
  assert.equal(r.calls.length, 2)
  assert.equal(r.calls[1].p_sold_by, undefined)
  assert.match(logs[0][0], /falta la migración/)

  const r2 = recorder([{ data: null, error: { code: 'P0001', message: 'Vendedor no valido' } }])
  await assert.rejects(makeSupabaseSaleExecutor(async () => 'tok', r2.rpc, { log: () => {} })(draft({ sold_by: SELLER }), async () => {}), SaleRejectedByPosError)
  assert.equal(r2.calls.length, 1)
})

// ------------------------------------------------------------------ real SQL on a throwaway cluster
// First Postgres whose binaries actually run (PG_BIN overrides). Skipped if there is none.
const PG_BIN = [process.env.PG_BIN, '/Library/PostgreSQL/16/bin', '/Library/PostgreSQL/14/bin', '/Library/PostgreSQL/12/bin',
  '/opt/homebrew/opt/postgresql@16/bin', '/opt/homebrew/opt/postgresql@15/bin', '/opt/homebrew/opt/postgresql@13/bin',
  '/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/15/bin', '/usr/local/bin', '/opt/homebrew/bin']
  .filter(Boolean)
  .find(dir => existsSync(join(dir, 'initdb')) && existsSync(join(dir, 'pg_ctl')) && spawnSync(join(dir, 'postgres'), ['-V']).status === 0)

test('migración 20261116 en un Postgres local desechable: create_sale sigue igual sin parámetros nuevos', { skip: !PG_BIN && 'sin Postgres local' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sales-attr-pg-'))
  const data = join(dir, 'data')
  const sock = dir
  const port = String(55000 + Math.floor(Math.random() * 900))
  const bin = name => join(PG_BIN, name)
  execFileSync(bin('initdb'), ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8'], { stdio: 'ignore' })
  execFileSync(bin('pg_ctl'), ['-D', data, '-o', `-p ${port} -k ${sock} -c listen_addresses=''`, '-w', 'start'], { stdio: 'ignore' })
  const psql = (sql, { fail = false } = {}) => {
    const res = spawnSync(bin('psql'), ['-h', sock, '-p', port, '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-qtA', '-f', '-'], { encoding: 'utf8', input: sql })
    if (fail) { assert.notEqual(res.status, 0, `debía fallar: ${sql}`); return res.stderr }
    assert.equal(res.status, 0, res.stderr)
    return res.stdout.trim()
  }
  const file = async path => {
    const res = spawnSync(bin('psql'), ['-h', sock, '-p', port, '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-f', path], { encoding: 'utf8' })
    assert.equal(res.status, 0, res.stderr)
  }
  try {
    psql('create extension if not exists pgcrypto')
    await file(new URL('./sql/stub-schema.sql', import.meta.url).pathname)
    // The CURRENT create_sale (20260223_fifo_cost_layers.sql), extracted as-is.
    const fifo = await readFile(new URL('../supabase/archive/migrations-pre-baseline/20260223_fifo_cost_layers.sql', import.meta.url), 'utf8')
    const start = fifo.indexOf('create or replace function public.create_sale(')
    const end = fifo.indexOf('\n$$;\n', start) + 5
    const current = join(dir, 'current.sql')
    await writeFile(current, `${fifo.slice(start, end)}\ngrant execute on function public.create_sale(uuid, text, jsonb) to authenticated;\n`)
    await file(current)

    const CASHIER = '33333333-3333-4333-8333-333333333333'
    const BANNED = '44444444-4444-4444-8444-444444444444'
    const P = '55555555-5555-4555-8555-555555555555'
    psql(`insert into auth.users (id) values ('${SELLER}'), ('${OWNER}'), ('${CASHIER}');
          insert into auth.users (id, banned_until) values ('${BANNED}', now() + interval '1 day');
          insert into public.profiles (id, role) values ('${SELLER}', 'cashier'), ('${OWNER}', 'owner'), ('${CASHIER}', 'cashier'), ('${BANNED}', 'cashier');
          insert into public.products values ('${P}', 'Cuaderno', 'unidad', 5, 100, 3, 0, now());`)
    const as = (user, call) => `set request.jwt.claim.sub = '${user}';\nselect ${call};`
    const items = `'[{"product_id":"${P}","qty":1,"unit_name":"unidad","price_unit":5}]'::jsonb`
    const manual = `'[{"product_id":"${P}","qty":1,"unit_name":"unidad","price_unit":6,"manual_discount_reason":"Precio dictado"}]'::jsonb`
    const oldCall = `public.create_sale(p_customer_id := null, p_payment_method := 'efectivo', p_items := ${items})`

    // Before the migration.
    const before = psql(as(SELLER, oldCall))
    assert.match(before, /^[0-9a-f-]{36}$/)

    await file(new URL('../supabase/archive/migrations-pre-baseline/20261116_sales_attribution.sql', import.meta.url).pathname)
    assert.equal(psql(`select count(*) from pg_proc where proname = 'create_sale'`), '1', 'una sola create_sale (sin ambigüedad)')
    assert.equal(psql(`select has_function_privilege('authenticated', 'public.create_sale(uuid,text,jsonb,uuid,uuid)', 'execute')`), 't')
    assert.equal(psql(`select count(*) from public.sales where sold_by is null and approved_by is null`), '1', 'no toca ventas existentes')

    // The SAME old call (named and positional) keeps working: created_by = sold_by = auth.uid().
    const after = psql(as(SELLER, oldCall))
    assert.equal(psql(`select created_by || '|' || sold_by || '|' || coalesce(approved_by::text, '-') from public.sales where id = '${after}'`), `${SELLER}|${SELLER}|-`)
    const positional = psql(as(SELLER, `public.create_sale(null, 'efectivo', ${items})`))
    assert.match(positional, /^[0-9a-f-]{36}$/)

    // Review approval: owner registers in the seller's name at the dictated price.
    const approved = psql(as(OWNER, `public.create_sale(p_customer_id := null, p_payment_method := 'efectivo', p_items := ${manual}, p_sold_by := '${SELLER}', p_approved_by := '${OWNER}')`))
    assert.equal(psql(`select created_by || '|' || sold_by || '|' || approved_by from public.sales where id = '${approved}'`), `${OWNER}|${SELLER}|${OWNER}`)
    assert.equal(psql(`select price_unit_uom || '|' || auto_price_unit from public.sale_items where sale_id = '${approved}'`), '6.0000|5')

    // Validations.
    assert.match(psql(as(CASHIER, `public.create_sale(null, 'efectivo', ${items}, '${SELLER}')`), { fail: true }), /no permite registrar ventas a nombre de otro vendedor/)
    assert.match(psql(as(OWNER, `public.create_sale(null, 'efectivo', ${items}, '${BANNED}')`), { fail: true }), /Vendedor no valido o inactivo/)
    assert.match(psql(as(OWNER, `public.create_sale(null, 'efectivo', ${items}, '${OWNER.replace('2222', '9999')}')`), { fail: true }), /Vendedor no valido o inactivo/)
    assert.match(psql(as(OWNER, `public.create_sale(null, 'efectivo', ${items}, '${SELLER}', '${SELLER}')`), { fail: true }), /approved_by debe ser el usuario que aprueba/)
    assert.match(psql(as(CASHIER, `public.create_sale(null, 'efectivo', ${items}, null, '${CASHIER}')`), { fail: true }), /no permite aprobar/)
    const self = psql(as(CASHIER, `public.create_sale(null, 'efectivo', ${items}, '${CASHIER}')`))
    assert.match(self, /^[0-9a-f-]{36}$/, 'un cajero puede ponerse a sí mismo como vendedor')

    // Rollback restores the old signature; the old call still works; columns are kept.
    await file(new URL('../supabase/rollbacks/20261116_sales_attribution_down.sql', import.meta.url).pathname)
    assert.equal(psql(`select pg_get_function_identity_arguments('public.create_sale'::regproc)`), 'p_customer_id uuid, p_payment_method text, p_items jsonb')
    assert.match(psql(as(SELLER, oldCall)), /^[0-9a-f-]{36}$/)
    assert.equal(psql(`select count(*) from information_schema.columns where table_name = 'sales' and column_name in ('sold_by', 'approved_by')`), '2')
  } finally {
    spawnSync(bin('pg_ctl'), ['-D', data, '-m', 'immediate', 'stop'], { stdio: 'ignore' })
    await rm(dir, { recursive: true, force: true })
  }
})
