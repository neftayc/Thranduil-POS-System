import dotenv from 'dotenv'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

dotenv.config({ quiet: true })
const base = (process.env.POS_AGENT_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '')
const key = process.env.POS_AGENT_TOKEN
if (!key || key.length < 32) throw new Error('Configura POS_AGENT_TOKEN en .env; su valor nunca se imprime')
const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
const call = async (path, body, auth = true) => {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: auth ? headers : { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) })
  const data = await response.json()
  return { response, data }
}

assert.equal((await call('/api/agent/context', null, false)).response.status, 401)
const context = await call('/api/agent/context')
assert.equal(context.response.status, 200)
assert.equal(context.data.system_id, 'pos')
assert.ok(JSON.stringify(context.data).length < 16000)
console.log(JSON.stringify({ check: 'context', status: 200, system_id: context.data.system_id, execution_configured: context.data.context.execution_configured }))

const malformed = await call('/api/agent/instructions', { protocol: 'incorrecto' })
assert.equal(malformed.response.status, 400)
console.log('Credencial y validación del contrato: OK')

if (process.argv.includes('--prepare')) {
  // Prepares an intentionally incomplete order. This script NEVER sends a confirmation.
  const body = { protocol: 'yachay-agent/1', type: 'instruction', request_id: randomUUID(), input: { text: 'vender cuader a4 100 cuadriculado', locale: 'es-PE' } }
  let prepared = await call('/api/agent/instructions', body)
  for (let attempt = 0; prepared.data.status === 'pending' && attempt < 15; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 2000))
    prepared = await call('/api/agent/instructions', body)
  }
  assert.equal(prepared.response.status, 200)
  console.log(JSON.stringify({ check: 'prepare', ...prepared.data }))
  assert.ok(['needs_clarification', 'requires_confirmation'].includes(prepared.data.status), 'El intérprete no pudo preparar el pedido')
  const retry = await call('/api/agent/instructions', body)
  assert.deepEqual(retry.data, prepared.data)
  const conflict = await call('/api/agent/instructions', { ...body, input: { text: 'otro pedido', locale: 'es-PE' } })
  assert.equal(conflict.response.status, 409)
  console.log('Preparación real, reintento idéntico y conflicto de request_id: OK. No se solicitó registrar ninguna venta.')
}
