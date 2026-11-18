// Try the sales selector with a dictation of your own (simulation: snapshot catalog, nothing is registered).
//   node scripts/try-selector.mjs "5 cartulinas blancas, 2 lapiceros de 0,60"
//   node scripts/try-selector.mjs --sin-revisor "…"          (one pass only)
//   node scripts/try-selector.mjs --modelo gpt-5.4-mini "…"  (another model)
import fs from 'node:fs'
import dotenv from 'dotenv'
import { createRequire } from 'node:module'

dotenv.config({ quiet: true })
const jiti = createRequire(import.meta.resolve('nuxt/package.json'))('jiti').createJiti(import.meta.url)
const { makeSalesSelector } = await jiti.import('../server/modules/agent/app/salesSelector.ts')
const { makeSalesReviewer } = await jiti.import('../server/modules/agent/app/salesReviewer.ts')
const { makeOpenAISelectorModel, makeOpenAIReviewerModel } = await jiti.import('../server/modules/agent/infra/openaiSalesSelector.ts')

const args = process.argv.slice(2)
const flag = name => { const i = args.indexOf(name); if (i < 0) return null; const [, value] = args.splice(i, 2); return value }
const noReview = args.includes('--sin-revisor') && args.splice(args.indexOf('--sin-revisor'), 1)
const model = flag('--modelo') || process.env.POS_AGENT_SELECTOR_MODEL || 'gpt-5.4'
const text = args.join(' ').trim()
if (!text) { console.error('Escribe el pedido entre comillas: node scripts/try-selector.mjs "5 cartulinas blancas, ..."'); process.exit(1) }
if (!process.env.OPENAI_API_KEY) { console.error('Falta OPENAI_API_KEY en .env'); process.exit(1) }

const catalog = JSON.parse(fs.readFileSync(new URL('../tests/fixtures/selector-catalog.json', import.meta.url)))
const name = id => catalog.products.find(p => p.id === id)?.name ?? '—'
const select = makeSalesSelector({
  model: makeOpenAISelectorModel(process.env.OPENAI_API_KEY, model),
  catalog: async () => catalog,
  ...(noReview ? {} : { reviewer: makeSalesReviewer(makeOpenAIReviewerModel(process.env.OPENAI_API_KEY, model)) })
})
const started = Date.now()
const { consolidated, usage } = await select({ messages: [text] })
const seconds = ((Date.now() - started) / 1000).toFixed(1)
console.log(`\nPedido: «${text}»\nModelo: ${model}${noReview ? ' (una pasada)' : ' (con revisión)'} · tiempo: ${seconds} s\n`)
for (const l of consolidated.lines) {
  const sure = l.confidence === 'alta' && l.product_id
  console.log(`${sure ? '✔' : '❓'} ${l.quantity ?? '?'} × ${name(l.product_id)}   «${l.phrase}»`)
  if (!sure) console.log(`     pregunta: ${l.question}${l.options.length ? `\n     opciones: ${l.options.map(name).join(' / ')}` : ''}`)
}
console.log(`\nPago: ${consolidated.payment_method}`)
console.log(consolidated.lines.every(l => l.confidence === 'alta' && l.product_id) ? 'Resultado: se registraría DIRECTO (si precio y stock están bien).' : 'Resultado: quedaría POR CONFIRMAR (hay preguntas).')
