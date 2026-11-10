import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const requireNuxt = createRequire(import.meta.resolve('nuxt/package.json'))
const { createJiti } = requireNuxt('jiti')
const jiti = createJiti(import.meta.url)
const {
  makeSellerSessions, makeSealer, endOfWorkdayLima, IdentificationError, SellerRejectedError, MAX_APPROVAL_FAILURES
} = await jiti.import('../server/modules/agent/app/sellerSessions.ts')
const { makeFileSellerSessionStore } = await jiti.import('../server/modules/agent/infra/fileSellerSessionStore.ts')

const KEY = 'clave-de-prueba-no-es-un-secreto-real-0123456789'
const LINK = 'http://127.0.0.1:3000/vincular'

// Fake Supabase Auth: users by email; tokens are opaque strings.
function fakeAuth() {
  const users = {
    'ana@tienda.pe': { password: 'clave-ana', user_id: 'user-ana', name: 'Ana Pérez', role: 'cashier', banned: false },
    'sinrol@tienda.pe': { password: 'clave-x', user_id: 'user-x', name: 'Sin Rol', role: '', banned: false },
    'baja@tienda.pe': { password: 'clave-b', user_id: 'user-b', name: 'Dado de baja', role: 'cashier', banned: true }
  }
  const state = { refreshes: 0, signOuts: 0, failRefresh: false, ttl: 3600 }
  let n = 0
  const issue = email => ({ access_token: `access-${email}-${++n}`, refresh_token: `refresh-${email}-${n}`, expires_at: Math.floor(Date.now() / 1000) + state.ttl })
  const byToken = token => Object.entries(users).find(([email]) => token.startsWith(`access-${email}-`))
  return {
    users, state,
    gateway: {
      async signIn(email, password) {
        if (users[email]?.password !== password) throw new Error('invalid')
        return issue(email)
      },
      async refresh(refreshToken) {
        state.refreshes++
        await new Promise(resolve => setTimeout(resolve, 10))
        if (state.failRefresh) throw new Error('revoked')
        const email = Object.keys(users).find(e => refreshToken.startsWith(`refresh-${e}-`))
        state.ttl = 3600
        return issue(email)
      },
      async profile(accessToken) {
        const found = byToken(accessToken)
        if (!found) throw new Error('bad token')
        const { user_id, name, role, banned } = found[1]
        return { user_id, name, role, banned }
      },
      async signOut() { state.signOuts++ }
    }
  }
}

async function setup(t, now = () => Date.now()) {
  const dir = await mkdtemp(join(tmpdir(), 'papeleria-sessions-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const auth = fakeAuth()
  const sessions = makeSellerSessions({ store: makeFileSellerSessionStore(dir), auth: auth.gateway, sealer: makeSealer(KEY), now })
  return { sessions, auth, dir }
}

async function approveAna(sessions) {
  const started = await sessions.start(LINK)
  await sessions.approve(started.user_code.toLowerCase(), 'ana@tienda.pe', 'clave-ana')
  const approved = await sessions.status(started.identification_id)
  return { started, approved }
}

test('inicia con enlace propio, código corto y vencimiento; queda pendiente hasta aprobar', async t => {
  const { sessions } = await setup(t)
  const started = await sessions.start(LINK)
  assert.equal(started.status, 'requires_identification')
  assert.match(started.user_code, /^[A-Z2-9]{3}-[A-Z2-9]{4}$/)
  assert.equal(started.verification_url, LINK)
  assert.equal(started.expires_in, 600)
  assert.deepEqual(await sessions.status(started.identification_id), { status: 'pending' })
  assert.deepEqual(await sessions.status(started.identification_id.replace(/.$/, 'x')), { status: 'denied' })
})

test('aprueba con el usuario del POS y entrega la sesión una sola vez', async t => {
  const { sessions } = await setup(t)
  const { started, approved } = await approveAna(sessions)
  assert.equal(approved.status, 'approved')
  assert.deepEqual(approved.seller, { name: 'Ana Pérez', role: 'cashier' })
  assert.ok(approved.expires_at * 1000 > Date.now())
  assert.deepEqual(await sessions.status(started.identification_id), { status: 'expired' })
  const seller = await sessions.resolve(approved.session)
  assert.equal(seller.user_id, 'user-ana')
  assert.match(await seller.authorize(), /^access-ana@tienda\.pe-/)
})

test('los archivos guardan hashes y tokens cifrados, nunca en claro', async t => {
  const { sessions, dir } = await setup(t)
  const { approved } = await approveAna(sessions)
  const contents = (await Promise.all((await readdir(dir)).map(f => readFile(join(dir, f), 'utf8')))).join('\n')
  assert.doesNotMatch(contents, /access-ana|refresh-ana|clave-ana/)
  assert.ok(!contents.includes(approved.session.split('.')[1]))
})

test('contraseña incorrecta no aprueba y tras varios intentos anula el código', async t => {
  const { sessions } = await setup(t)
  const started = await sessions.start(LINK)
  for (let i = 1; i < MAX_APPROVAL_FAILURES; i++) {
    await assert.rejects(sessions.approve(started.user_code, 'ana@tienda.pe', 'mala'), /Correo o contraseña incorrectos/)
  }
  await assert.rejects(sessions.approve(started.user_code, 'ana@tienda.pe', 'mala'), /Demasiados intentos/)
  await assert.rejects(sessions.approve(started.user_code, 'ana@tienda.pe', 'clave-ana'), /no existe o venció/)
  assert.deepEqual(await sessions.status(started.identification_id), { status: 'denied' })
})

test('un usuario sin rol o desactivado no puede vincularse y su sesión se cierra', async t => {
  const { sessions, auth } = await setup(t)
  const a = await sessions.start(LINK)
  await assert.rejects(sessions.approve(a.user_code, 'sinrol@tienda.pe', 'clave-x'), err => err instanceof IdentificationError && /rol de vendedor válido/.test(err.message))
  assert.deepEqual(await sessions.status(a.identification_id), { status: 'denied' })
  const b = await sessions.start(LINK)
  await assert.rejects(sessions.approve(b.user_code, 'baja@tienda.pe', 'clave-b'), /desactivado/)
  assert.equal(auth.state.signOuts, 2)
})

test('un código vencido no se puede aprobar', async t => {
  let now = Date.now()
  const { sessions } = await setup(t, () => now)
  const started = await sessions.start(LINK)
  now += 601_000
  await assert.rejects(sessions.approve(started.user_code, 'ana@tienda.pe', 'clave-ana'), /no existe o venció/)
  assert.deepEqual(await sessions.status(started.identification_id), { status: 'expired' })
})

test('una referencia alterada, desconocida o ausente se rechaza sin detalles', async t => {
  const { sessions } = await setup(t)
  const { approved } = await approveAna(sessions)
  const [id, secret] = approved.session.split('.')
  for (const ref of [`${id}.${secret.slice(0, -1)}A`, `00000000-0000-0000-0000-000000000000.${secret}`, '', 'basura']) {
    await assert.rejects(sessions.resolve(ref), err => err instanceof SellerRejectedError && !err.message.includes(secret))
  }
})

test('revocar desde el POS invalida la sesión de inmediato', async t => {
  const { sessions } = await setup(t)
  const { approved } = await approveAna(sessions)
  const seller = await sessions.resolve(approved.session)
  const [listed] = await sessions.list()
  assert.equal(listed.active, true)
  assert.equal(await sessions.revoke(listed.id), true)
  await assert.rejects(sessions.resolve(approved.session), /revocada/)
  await assert.rejects(seller.authorize(), /revocada/)
  assert.equal((await sessions.list())[0].active, false)
})

test('la sesión vence al final de la jornada en Lima', async t => {
  let now = Date.UTC(2026, 10, 10, 20, 0, 0) // 15:00 en Lima
  assert.equal(endOfWorkdayLima(now), Date.UTC(2026, 10, 11, 4, 59, 59))
  assert.equal(endOfWorkdayLima(Date.UTC(2026, 10, 11, 3, 0, 0)), Date.UTC(2026, 10, 11, 4, 59, 59))
  const { sessions } = await setup(t, () => now)
  const { approved } = await approveAna(sessions)
  now = Date.UTC(2026, 10, 11, 5, 0, 0)
  await assert.rejects(sessions.resolve(approved.session), /venció/)
})

test('si le quitan el rol o lo desactivan después, ya no puede preparar ni registrar', async t => {
  const { sessions, auth } = await setup(t)
  const { approved } = await approveAna(sessions)
  const seller = await sessions.resolve(approved.session)
  auth.users['ana@tienda.pe'].role = 'viewer'
  await assert.rejects(seller.authorize(), /rol de vendedor válido/)
  await assert.rejects(sessions.resolve(approved.session), /rol de vendedor válido/)
  auth.users['ana@tienda.pe'].role = 'cashier'
  auth.users['ana@tienda.pe'].banned = true
  await assert.rejects(sessions.resolve(approved.session), /desactivado/)
})

test('renueva el token una sola vez ante llamadas concurrentes y rechaza si Supabase lo revoca', async t => {
  const { sessions, auth } = await setup(t)
  auth.state.ttl = 30 // access token about to expire
  const { approved } = await approveAna(sessions)
  const seller = await sessions.resolve(approved.session)
  assert.equal(auth.state.refreshes, 1)
  auth.state.ttl = 30
  const second = await sessions.resolve(approved.session)
  assert.ok(second)
  // A refreshed session with a long TTL does not refresh again.
  const before = auth.state.refreshes
  await Promise.all([seller.authorize(), seller.authorize()])
  assert.ok(auth.state.refreshes - before <= 1)
  auth.state.failRefresh = true
  auth.state.ttl = 30
  const fresh = await approveAna(sessions)
  await assert.rejects(sessions.resolve(fresh.approved.session), /no es válida/)
})

test('la clave de cifrado es obligatoria y larga', () => {
  assert.throws(() => makeSealer('corta'), /POS_AGENT_SESSION_KEY/)
})
