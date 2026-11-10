// Reproduces the pre-hybrid findProducts (every term must match name/brand/sku via ilike, limit 8)
// over the catalog snapshot, to measure the "before" accuracy. Offline, read-only.
import fs from 'node:fs'
const catalog = JSON.parse(fs.readFileSync(new URL('../../tests/fixtures/catalog-snapshot.json', import.meta.url)))
const cases = JSON.parse(fs.readFileSync(new URL('../../tests/fixtures/agent-search-cases.json', import.meta.url)))
const stopwords = new Set(['de', 'del', 'el', 'la', 'los', 'las', 'un', 'una', 'con', 'para', 'hoja', 'hojas'])
const tokens = text => text.match(/[\p{L}\p{N}]+/gu)?.filter(t => !stopwords.has(t.toLowerCase())).slice(0, 16) || []
const find = text => {
  const terms = tokens(text.replace(/^vender\s+/i, ''))
  return catalog.filter(p => terms.every(t => [p.name, p.brand, p.sku].some(v => v && v.toLowerCase().includes(t.toLowerCase()))))
    .sort((a, b) => a.name.localeCompare(b.name)).slice(0, 8)
}
let exact = 0, found = 0, safe = 0, zero = 0
const positives = cases.filter(c => c.expect === 'high'), negatives = cases.filter(c => c.expect !== 'high')
for (const c of cases) {
  const r = find(c.text)
  if (!r.length) zero++
  if (c.expect === 'high') {
    if (r.length === 1 && c.expected.includes(r[0].id)) exact++
    if (r.some(p => c.expected.includes(p.id))) found++
  } else if (!(r.length === 1 && !c.expected.includes(r[0].id))) safe++
  console.log(`${r.length === 1 ? 'único' : r.length ? r.length + ' opc' : 'NADA '} | ${c.text}`)
}
console.log(JSON.stringify({ casos: cases.length, positivos: positives.length, resuelto_unico_correcto: exact, correcto_entre_resultados: found, sin_resultados: zero, negativos_sin_error: `${safe}/${negatives.length}` }))
