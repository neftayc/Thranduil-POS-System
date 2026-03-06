#!/usr/bin/env node
// Script para generar y guardar embeddings del catálogo de productos en Supabase.
// Ejecutar con: node scripts/embed-catalog.mjs

import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

// Load .env manually (compatible with all dotenv versions)
const __dirname = dirname(fileURLToPath(import.meta.url))
const envPath = join(__dirname, '../.env')
const envVars = Object.fromEntries(
  readFileSync(envPath, 'utf-8')
    .split('\n')
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)
Object.assign(process.env, envVars)

const SUPABASE_URL    = process.env.NUXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY    = process.env.SUPABASE_SERVICE_ROLE || process.env.NUXT_PUBLIC_SUPABASE_ANON_KEY
const OPENAI_API_KEY  = process.env.OPENAI_API_KEY
const ACCESS_TOKEN    = process.env.AUTH_TOKEN // optional: user JWT for auth
const BATCH_SIZE      = 50

if (!SUPABASE_URL || !SUPABASE_KEY || !OPENAI_API_KEY) {
  console.error('❌ Faltan variables: NUXT_PUBLIC_SUPABASE_URL, OPENAI_API_KEY')
  process.exit(1)
}

const supabaseOpts = ACCESS_TOKEN
  ? { global: { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } } }
  : {}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, supabaseOpts)
const openai   = new OpenAI({ apiKey: OPENAI_API_KEY })

console.log('🔍 Fetching products...')
const { data: products, error } = await supabase
  .from('products')
  .select('id, name, sku, unit')
  .eq('active', true)

if (error) { console.error('❌ Supabase error:', error.message); process.exit(1) }

console.log(`📦 ${products.length} productos encontrados`)

const texts = products.map(p =>
  [p.name, p.unit ? `unidad: ${p.unit}` : '', p.sku ? `sku: ${p.sku}` : '']
    .filter(Boolean).join(' | ')
)

let totalTokens = 0
const embeddings = []

for (let i = 0; i < texts.length; i += BATCH_SIZE) {
  const batch = texts.slice(i, i + BATCH_SIZE)
  process.stdout.write(`⚡ Embeddeando ${i + 1}–${Math.min(i + BATCH_SIZE, texts.length)} / ${texts.length}...`)

  const res = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: batch
  })

  res.data.forEach(d => embeddings.push(d.embedding))
  totalTokens += res.usage?.total_tokens ?? 0
  console.log(' ✓')
}

console.log('💾 Guardando embeddings en Supabase...')

const updates = products.map((p, i) => ({
  id: p.id,
  embedding: embeddings[i]   // pgvector accepts JS number[]
}))

// Update each product's embedding individually (no upsert needed, products already exist)
for (let i = 0; i < products.length; i++) {
  const { error: updateErr } = await supabase
    .from('products')
    .update({ embedding: embeddings[i] })
    .eq('id', products[i].id)
  if (updateErr) {
    console.error(`❌ Error en producto ${products[i].name}:`, updateErr.message)
    process.exit(1)
  }
  if ((i + 1) % 50 === 0 || i === products.length - 1) {
    console.log(`  ✓ ${i + 1}/${products.length} guardados`)
  }
}

const costUsd = (totalTokens * 0.00000002).toFixed(6)
console.log(`\n✅ ${products.length} productos embeddeados`)
console.log(`📊 Tokens usados: ${totalTokens}  |  Costo estimado: $${costUsd}`)
