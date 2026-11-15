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
  makeSellerSessions, makeSealer, endOfWorkdayLima, IdentificationError, SellerRejectedError, MAX_APPROVAL_FAILURES, MAX_MATCH_FAILURES
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
  const state = { refreshes: 0, signOuts: 0, signedOut: [], failRefresh: false, failSignOut: false, ttl: 3600, refreshDelay: 10, signInDelay: 0, onProfile: null }
  let n = 0
  const issue = email => ({ access_token: `access-${email}-${++n}`, refresh_token: `refresh-${email}-${n}`, expires_at: Math.floor(Date.now() / 1000) + state.ttl })
  const byToken = token => Object.entries(users).find(([email]) => token.startsWith(`access-${email}-`))
  return {
    users, state,
    gateway: {
      async signIn(email, password) {
        if (state.signInDelay) await new Promise(resolve => setTimeout(resolve, state.signInDelay))
        if (users[email]?.password !== password) throw new Error('invalid')
        return issue(email)
      },
      async refresh(refreshToken) {
        state.refreshes++
        if (state.onRefreshStart) state.onRefreshStart()
        await new Promise(resolve => setTimeout(resolve, state.refreshDelay))
        if (state.failRefresh) throw new Error('revoked')
        const email = Object.keys(users).find(e => refreshToken.startsWith(`refresh-${e}-`))
        return { ...issue(email), expires_at: Math.floor(Date.now() / 1000) + 3600 }
      },
      async profile(accessToken) {
        const found = byToken(accessToken)
        if (!found) throw new Error('bad token')
        if (state.onProfile) await state.onProfile()
        const { user_id, name, role, banned } = found[1]
        return { user_id, name, role, banned }
      },
      async signOut(accessToken) {
        state.signOuts++
        if (state.failSignOut) throw new Error('supabase caído')
        state.signedOut.push(accessToken)
      }
    }
  }
}

async function setup(t, now = () => Date.now(), limits) {
  const dir = await mkdtemp(join(tmpdir(), 'papeleria-sessions-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const auth = fakeAuth()
  const logs = []
  const sessions = makeSellerSessions({ store: makeFileSellerSessionStore(dir), auth: auth.gateway, sealer: makeSealer(KEY), now, log: m => logs.push(m), limits })
  return { sessions, auth, dir, logs }
}

async function approveAna(sessions) {
  const started = await sessions.start(LINK)
  const page = await sessions.approve(started.user_code.toLowerCase(), 'ana@tienda.pe', 'clave-ana')
  const approved = await sessions.status(started.identification_id, page.match_code)
  return { started, approved, page }
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
  await assert.rejects(sessions.approve(started.user_code, 'otra@tienda.pe', 'x'), /no existe o venció/)
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
  for (const ref of [`${id}.${secret.slice(0, -1)}${secret.endsWith("A") ? "B" : "A"}`, `00000000-0000-0000-0000-000000000000.${secret}`, '', 'basura']) {
    await assert.rejects(sessions.resolve(ref), err => err instanceof SellerRejectedError && !err.message.includes(secret))
  }
})

test('revocar desde el POS invalida la sesión de inmediato', async t => {
  const { sessions } = await setup(t)
  const { approved } = await approveAna(sessions)
  const seller = await sessions.resolve(approved.session)
  const [listed] = await sessions.list()
  assert.equal(listed.active, true)
  assert.deepEqual(await sessions.revoke(listed.id), { revoked: true, supabase_signed_out: true })
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

// --- Correcciones de la revisión de seguridad ---

test('A1: una revocación durante el refresh no se pierde y cierra los tokens nuevos', async t => {
  const { sessions, auth } = await setup(t)
  auth.state.ttl = 30 // the stored access token is about to expire: resolve() must refresh
  const started = await sessions.start(LINK)
  const page = await sessions.approve(started.user_code, 'ana@tienda.pe', 'clave-ana')
  const { session: ref } = await sessions.status(started.identification_id, page.match_code)
  const [listed] = await sessions.list()
  auth.state.refreshDelay = 50
  // Wait for the refresh to actually START (no fixed sleep: resolve() reads files first).
  const refreshStarted = new Promise(resolve => { auth.state.onRefreshStart = resolve })
  const resolving = sessions.resolve(ref).then(() => 'ok', err => err.message)
  await refreshStarted // refresh in flight
  auth.state.onRefreshStart = null
  assert.equal(auth.state.refreshes, 1)
  const revoked = await sessions.revoke(listed.id)
  assert.equal(revoked.revoked, true)
  await resolving
  const after = (await sessions.list()).find(s => s.id === listed.id)
  assert.ok(after.revoked_at, 'revoked_at no debe volver a null')
  await assert.rejects(sessions.resolve(ref), /revocada/)
  // The tokens obtained by the in-flight refresh are the ones closed in Supabase.
  assert.equal(auth.state.signedOut.length, 1)
  assert.match(auth.state.signedOut[0], /^access-ana@tienda\.pe-2$/)
})

test('A1: revocar con el access token vencido lo renueva y cierra la sesión de Supabase', async t => {
  const { sessions, auth } = await setup(t)
  auth.state.ttl = 10 // vencido para la ventana de 30 s de revoke
  await approveAna(sessions)
  const [listed] = await sessions.list()
  const result = await sessions.revoke(listed.id)
  assert.deepEqual(result, { revoked: true, supabase_signed_out: true })
  assert.equal(auth.state.refreshes, 1)
  assert.equal(auth.state.signedOut.length, 1)
})

test('A1: un fallo al cerrar en Supabase se registra (sin secretos) y la sesión queda revocada', async t => {
  const { sessions, auth, logs } = await setup(t)
  const { approved } = await approveAna(sessions)
  const [listed] = await sessions.list()
  auth.state.failSignOut = true
  assert.deepEqual(await sessions.revoke(listed.id), { revoked: true, supabase_signed_out: false })
  assert.equal(logs.length, 1)
  assert.match(logs[0], /no se pudo cerrar/)
  assert.doesNotMatch(logs[0], /access-|refresh-/)
  await assert.rejects(sessions.resolve(approved.session), /revocada/)
})

test('A1: authorize vuelve a comprobar la revocación justo antes de entregar el token', async t => {
  const { sessions, auth } = await setup(t)
  const { approved } = await approveAna(sessions)
  const seller = await sessions.resolve(approved.session)
  const [listed] = await sessions.list()
  auth.state.onProfile = async () => { auth.state.onProfile = null; await sessions.revoke(listed.id) }
  await assert.rejects(seller.authorize(), /revocada/)
})

test('M5: intentos en paralelo cuentan cada fallo y anulan el código a los 5', async t => {
  const { sessions, auth } = await setup(t, undefined, { perEmail: 1000, perIp: 1000 })
  auth.state.signInDelay = 5
  const started = await sessions.start(LINK)
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => sessions.approve(started.user_code, 'ana@tienda.pe', 'mala')))
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 0)
  assert.equal(results.filter(r => /incorrectos|Demasiados/.test(r.reason?.message)).length, MAX_APPROVAL_FAILURES)
  assert.deepEqual(await sessions.status(started.identification_id), { status: 'denied' })
  await assert.rejects(sessions.approve(started.user_code, 'ana@tienda.pe', 'clave-ana'), /no existe o venció/)
})

test('M5: límite por correo entre códigos distintos; los aciertos no cuentan', async t => {
  const { sessions } = await setup(t, undefined, { perEmail: 3, perIp: 1000 })
  for (let i = 0; i < 6; i++) await approveAna(sessions) // aciertos: nunca bloquean
  for (let i = 0; i < 3; i++) {
    const s = await sessions.start(LINK)
    await assert.rejects(sessions.approve(s.user_code, 'ana@tienda.pe', 'mala'), /incorrectos/)
  }
  const s = await sessions.start(LINK)
  await assert.rejects(sessions.approve(s.user_code, 'ANA@tienda.pe', 'clave-ana'), /Demasiados intentos/)
  // Otro vendedor en la misma tienda (misma IP) no queda bloqueado.
  const other = await sessions.start(LINK)
  await assert.rejects(sessions.approve(other.user_code, 'sinrol@tienda.pe', 'clave-x'), /rol de vendedor/)
})

test('M5: peticiones basura sin código válido no bloquean la tienda; por IP solo cuentan fallos', async t => {
  const { sessions } = await setup(t, undefined, { perIp: 5 })
  for (let i = 0; i < 20; i++) await assert.rejects(sessions.approve('', 'x', 'y', '10.0.0.1'), /Completa/)
  for (let i = 0; i < 4; i++) await assert.rejects(sessions.approve('ZZZ-ZZZZ', 'x@y.pe', 'y', '10.0.0.1'), /no existe/)
  const s = await sessions.start(LINK)
  await sessions.approve(s.user_code, 'ana@tienda.pe', 'clave-ana', '10.0.0.1')
  await assert.rejects(sessions.approve('ZZZ-ZZZZ', 'x@y.pe', 'y', '10.0.0.1'), /no existe/)
  const blocked = await sessions.start(LINK)
  await assert.rejects(sessions.approve(blocked.user_code, 'ana@tienda.pe', 'clave-ana', '10.0.0.1'), /Demasiados intentos/)
})

test('B1: un código crea una sola sesión y se entrega una sola vez aunque haya concurrencia', async t => {
  const { sessions, auth } = await setup(t)
  auth.state.signInDelay = 5
  const started = await sessions.start(LINK)
  const approvals = await Promise.allSettled([1, 2, 3].map(() => sessions.approve(started.user_code, 'ana@tienda.pe', 'clave-ana')))
  assert.equal(approvals.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal((await sessions.list()).length, 1)
  const match = approvals.find(r => r.status === 'fulfilled').value.match_code
  const polls = await Promise.all([1, 2, 3].map(() => sessions.status(started.identification_id, match)))
  assert.equal(polls.filter(p => p.status === 'approved').length, 1)
  assert.equal(polls.filter(p => p.status === 'expired').length, 2)
})

test('M4: /vincular puede mostrar la hora de la solicitud de un código pendiente', async t => {
  let now = Date.UTC(2026, 10, 10, 15, 42, 0)
  const { sessions } = await setup(t, () => now)
  const started = await sessions.start(LINK)
  const info = await sessions.lookup(started.user_code.toLowerCase())
  assert.equal(info.requested_at, Date.UTC(2026, 10, 10, 15, 42, 0))
  assert.equal(info.expires_at, Date.UTC(2026, 10, 10, 15, 52, 0))
  await assert.rejects(sessions.lookup('ZZZ-ZZZZ'), /no existe o venció/)
  now += 601_000
  await assert.rejects(sessions.lookup(started.user_code), /no existe o venció/)
})

// --- Correcciones de la revisión independiente (fase 3) ---

test('el rol sale del perfil vigente en cada petición, no del momento de aprobar', async t => {
  const { sessions, auth } = await setup(t)
  auth.users['ana@tienda.pe'].role = 'manager'
  const { approved } = await approveAna(sessions)
  assert.equal(approved.seller.role, 'manager')
  assert.equal((await sessions.resolve(approved.session)).role, 'manager')
  auth.users['ana@tienda.pe'].role = 'cashier' // la bajan a cajera
  const seller = await sessions.resolve(approved.session)
  assert.equal(seller.role, 'cashier')
  assert.equal((await sessions.list())[0].role, 'cashier')
  auth.users['ana@tienda.pe'].name = 'Ana P. Ríos'
  assert.equal((await sessions.resolve(approved.session)).name, 'Ana P. Ríos')
})

test('actualizar el rol nunca deshace una revocación', async t => {
  const { sessions, auth } = await setup(t)
  const { approved } = await approveAna(sessions)
  const [listed] = await sessions.list()
  auth.users['ana@tienda.pe'].role = 'manager'
  // Revoke while resolve() is validating the profile (before it persists the new role).
  auth.state.onProfile = async () => { auth.state.onProfile = null; await sessions.revoke(listed.id) }
  await assert.rejects(sessions.resolve(approved.session), /revocada/)
  assert.ok((await sessions.list())[0].revoked_at)
})

test('los fallos por correo se cuentan por correo+IP: un extraño no bloquea al vendedor', async t => {
  const { sessions } = await setup(t, undefined, { perEmail: 3, perIp: 1000 })
  for (let i = 0; i < 3; i++) {
    const s = await sessions.start(LINK)
    await assert.rejects(sessions.approve(s.user_code, 'ana@tienda.pe', 'mala', '203.0.113.9'), /incorrectos/)
  }
  const fromAttacker = await sessions.start(LINK)
  await assert.rejects(sessions.approve(fromAttacker.user_code, 'ana@tienda.pe', 'clave-ana', '203.0.113.9'), /Demasiados intentos/)
  // The same message for an email that does not exist: nothing is revealed.
  for (let i = 0; i < 3; i++) {
    const s = await sessions.start(LINK)
    await assert.rejects(sessions.approve(s.user_code, 'noexiste@tienda.pe', 'x', '203.0.113.9'), /incorrectos/)
  }
  const ghost = await sessions.start(LINK)
  await assert.rejects(sessions.approve(ghost.user_code, 'noexiste@tienda.pe', 'x', '203.0.113.9'), /Demasiados intentos/)
  // From the shop's IP, Ana can still link.
  const fromShop = await sessions.start(LINK)
  const ok = await sessions.approve(fromShop.user_code, 'ana@tienda.pe', 'clave-ana', '192.168.1.20')
  assert.equal(ok.name, 'Ana Pérez')
})

// --- Emparejamiento con número (antiphishing) ---

test('tras aprobar, la sesión solo se entrega con el número que muestra la página', async t => {
  const { sessions } = await setup(t)
  const started = await sessions.start(LINK)
  const page = await sessions.approve(started.user_code, 'ana@tienda.pe', 'clave-ana')
  assert.match(page.match_code, /^\d{3}$/)
  // The phisher's chat polls without the number: nothing is delivered.
  assert.deepEqual(await sessions.status(started.identification_id), { status: 'requires_match' })
  const ok = await sessions.status(started.identification_id, page.match_code)
  assert.equal(ok.status, 'approved')
  assert.ok((await sessions.resolve(ok.session)).user_id)
  assert.deepEqual(await sessions.status(started.identification_id, page.match_code), { status: 'expired' })
})

test('3 números equivocados anulan la solicitud y revocan la sesión creada', async t => {
  const { sessions } = await setup(t)
  const started = await sessions.start(LINK)
  const page = await sessions.approve(started.user_code, 'ana@tienda.pe', 'clave-ana')
  const wrong = page.match_code === '100' ? '101' : '100'
  for (let left = MAX_MATCH_FAILURES - 1; left > 0; left--) {
    assert.deepEqual(await sessions.status(started.identification_id, wrong), { status: 'match_mismatch', attempts_left: left })
  }
  assert.deepEqual(await sessions.status(started.identification_id, wrong), { status: 'denied' })
  assert.deepEqual(await sessions.status(started.identification_id, page.match_code), { status: 'denied' })
  const [session] = await sessions.list()
  assert.ok(session.revoked_at, 'la sesión creada al aprobar queda revocada')
})

test('si nadie escribe el número a tiempo, la solicitud vence y la sesión se revoca', async t => {
  let now = Date.now()
  const { sessions } = await setup(t, () => now)
  const started = await sessions.start(LINK)
  const page = await sessions.approve(started.user_code, 'ana@tienda.pe', 'clave-ana')
  now += 301_000
  assert.deepEqual(await sessions.status(started.identification_id, page.match_code), { status: 'expired' })
  assert.ok((await sessions.list())[0].revoked_at)
})

test('el número no se guarda en claro', async t => {
  const { sessions, dir } = await setup(t)
  const started = await sessions.start(LINK)
  const page = await sessions.approve(started.user_code, 'ana@tienda.pe', 'clave-ana')
  const record = JSON.parse(await readFile(join(dir, `identification-${started.identification_id.split('.')[0]}.json`), 'utf8'))
  assert.equal(record.match_code, undefined)
  assert.notEqual(record.match_hash, page.match_code)
})
