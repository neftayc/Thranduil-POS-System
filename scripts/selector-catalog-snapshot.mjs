// READ-ONLY snapshot of the real catalog for the sales-selector benchmark (tests/fixtures/selector-catalog.json).
// Active products with type, brand, presentations with price, wholesale tiers, stock and payment methods.
// No costs, customers, sales or users. Nothing is written to the database.
//   node scripts/selector-catalog-snapshot.mjs
import fs from 'node:fs'
import dotenv from 'dotenv'
import { createRequire } from 'node:module'
import { createClient } from '@supabase/supabase-js'

dotenv.config({ quiet: true })
const jiti = createRequire(import.meta.resolve('nuxt/package.json'))('jiti').createJiti(import.meta.url)
const { readSelectorRows, buildSelectorCatalog } = await jiti.import('../server/modules/agent/infra/supabaseSelectorCatalog.ts')
const url = process.env.SUPABASE_URL || process.env.NUXT_PUBLIC_SUPABASE_URL
if (!url || !process.env.SUPABASE_SERVICE_ROLE) { console.error('Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE en .env'); process.exit(1) }
const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } })
const catalog = buildSelectorCatalog(await readSelectorRows(db))
const out = new URL('../tests/fixtures/selector-catalog.json', import.meta.url)
fs.writeFileSync(out, JSON.stringify({ taken_at: new Date().toISOString().slice(0, 10), ...catalog }, null, 1) + '\n')
const withPrice = catalog.products.filter(p => p.presentations.some(pr => pr.price)).length
console.log(`Snapshot: ${catalog.products.length} productos (${withPrice} con precio), ${catalog.payment_methods.length} formas de pago → tests/fixtures/selector-catalog.json`)
