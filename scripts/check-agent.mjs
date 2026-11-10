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

// Without a seller session the POS refuses any instruction (before reading the body).
const noSeller = await call('/api/agent/instructions', { protocol: 'incorrecto' })
assert.equal(noSeller.response.status, 403)
const forged = await fetch(base + '/api/agent/instructions', {
  method: 'POST', headers: { ...headers, 'X-Yachay-Session': `${randomUUID()}.${'a'.repeat(43)}` }, body: '{}', signal: AbortSignal.timeout(60000)
})
assert.equal(forged.status, 403)
// Identification can start (needs POS_AGENT_SESSION_KEY); the handle is never printed.
const started = await call('/api/agent/identification', { protocol: 'yachay-identification/1', action: 'start' })
assert.equal(started.response.status, 200)
assert.equal(started.data.status, 'requires_identification')
console.log(JSON.stringify({ check: 'identification', user_code: started.data.user_code, verification_url: started.data.verification_url }))
console.log('Credencial, rechazo sin vendedor y vinculación: OK. Este script nunca envía pedidos: con un vendedor identificado el POS registraría la venta.')
