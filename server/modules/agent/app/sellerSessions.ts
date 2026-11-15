import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'

/**
 * Seller identification for the Yachay connector (device-flow style).
 *
 * 1. The connector asks to start: the POS returns an opaque identification handle (secret,
 *    only its hash is stored), a short user code and the link of THIS POS (/vincular).
 * 2. The seller opens the link, signs in with HIS/HER POS user and approves the code. The
 *    POS opens a dedicated Supabase session for the seller (never the service key).
 * 3. Number matching: after approving, the PAGE shows a 3-digit number that must be typed in
 *    the Claude chat. A phisher who started the request in their own chat never sees the
 *    victim's page, so they cannot complete it.
 * 4. The connector polls with the handle + number and receives, ONCE, an opaque session reference.
 *    Every later call carries it in X-Yachay-Session; the POS re-validates the seller.
 *
 * No password, token or reference is ever logged or returned in error messages.
 */

export const SELLER_ROLES = new Set(['owner', 'manager', 'cashier'])
export const IDENTIFICATION_TTL_SECONDS = 600
export const MAX_APPROVAL_FAILURES = 5
export const MAX_MATCH_FAILURES = 3
/** Time to type the number in Claude after approving on the page. */
export const MATCH_TTL_SECONDS = 300
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const LIMA_OFFSET_MS = -5 * 60 * 60 * 1000 // Peru has no DST.

export class SellerRejectedError extends Error {}
export class IdentificationError extends Error {}

export type AuthTokens = { access_token: string; refresh_token: string; expires_at: number }
export type SellerProfile = { user_id: string; name: string; role: string; banned: boolean }

export interface SellerAuthGateway {
  signIn(email: string, password: string): Promise<AuthTokens>
  refresh(refreshToken: string): Promise<AuthTokens>
  profile(accessToken: string): Promise<SellerProfile>
  signOut(accessToken: string): Promise<void>
}

export type IdentificationRecord = {
  id: string
  secret_hash: string
  user_code: string
  status: 'pending' | 'approved' | 'delivered' | 'denied'
  created_at: number
  expires_at: number
  failures: number
  session_ref_enc?: string
  seller?: { name: string; role: string }
  session_expires_at?: number
  /** Created at approval; revoked if the number is never matched. */
  session_id?: string
  match_hash?: string
  match_failures?: number
}

export type SellerSessionRecord = {
  id: string
  secret_hash: string
  user_id: string
  name: string
  role: string
  created_at: number
  expires_at: number
  revoked_at: number | null
  tokens_enc: string
}

export interface SellerSessionStore {
  getIdentification(id: string): Promise<IdentificationRecord | null>
  findIdentificationByCode(code: string): Promise<IdentificationRecord | null>
  saveIdentification(value: IdentificationRecord): Promise<void>
  getSession(id: string): Promise<SellerSessionRecord | null>
  saveSession(value: SellerSessionRecord): Promise<void>
  listSessions(): Promise<SellerSessionRecord[]>
}

export type ActiveSeller = {
  session_id: string
  user_id: string
  name: string
  role: string
  /** Re-validates the seller (role, not banned, session not revoked) and returns a fresh access token. */
  authorize(): Promise<string>
}

const sha256 = (value: string) => createHash('sha256').update(value).digest()
const sameHash = (value: string, hash: string) => {
  const expected = Buffer.from(hash, 'hex')
  const actual = sha256(value)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

export const makeSealer = (secret: string) => {
  if (String(secret || '').length < 32) throw new Error('POS_AGENT_SESSION_KEY debe tener al menos 32 caracteres')
  const key = createHash('sha256').update(`yachay-seller-session/1|${secret}`).digest()
  return {
    seal(value: unknown) {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url')
    },
    open<T>(sealed: string): T {
      const raw = Buffer.from(sealed, 'base64url')
      const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
      decipher.setAuthTag(raw.subarray(12, 28))
      return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')) as T
    }
  }
}

export const normalizeUserCode = (value: string) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
const formatCode = (raw: string) => `${raw.slice(0, 3)}-${raw.slice(3)}`
const newUserCode = () => {
  const bytes = randomBytes(7)
  return formatCode(Array.from(bytes, b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join(''))
}

/** End of the working day in Lima (23:59:59 local time), as epoch milliseconds. */
export const endOfWorkdayLima = (now: number) => {
  const local = new Date(now + LIMA_OFFSET_MS)
  local.setUTCHours(23, 59, 59, 0)
  return local.getTime() - LIMA_OFFSET_MS
}

const splitRef = (ref: string) => {
  const match = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{32,64})$/.exec(String(ref || ''))
  return match ? { id: match[1], secret: match[2] } : null
}

const SESSION_INVALID = 'La sesión del vendedor no es válida, venció o fue revocada. Vuelve a seleccionar el sistema e identifícate.'
const NO_ROLE = 'Tu usuario no tiene un rol de vendedor válido en el POS. No se puede preparar ni registrar ventas.'
const DISABLED = 'Tu usuario está desactivado en el POS. No se puede preparar ni registrar ventas.'

const INVALID_CODE = 'El código no existe o venció. Pide a Claude un código nuevo.'
const TOO_MANY = 'Demasiados intentos fallidos. Espera unos minutos y pide a Claude un código nuevo.'

/** Per-key failure counter (only failures count; successes never block anyone). */
export const makeFailureLimiter = (max: number, windowMs: number, now: () => number = Date.now) => {
  const entries = new Map<string, { count: number; since: number }>()
  const current = (key: string) => {
    const entry = entries.get(key)
    if (!entry || now() - entry.since > windowMs) return null
    return entry
  }
  return {
    blocked: (key: string) => (current(key)?.count || 0) >= max,
    fail(key: string) {
      const entry = current(key)
      if (entry) entry.count++
      else entries.set(key, { count: 1, since: now() })
    }
  }
}

/** In-process mutex per key. The POS agent storage is single-host by design. */
const makeLocks = () => {
  const tails = new Map<string, Promise<unknown>>()
  return async <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) || Promise.resolve()
    let release!: () => void
    const done = new Promise<void>(resolve => { release = resolve })
    const tail = previous.then(() => done)
    tails.set(key, tail)
    await previous
    try {
      return await work()
    } finally {
      release()
      if (tails.get(key) === tail) tails.delete(key)
    }
  }
}

export const makeSellerSessions = (deps: {
  store: SellerSessionStore
  auth: SellerAuthGateway
  sealer: ReturnType<typeof makeSealer>
  now?: () => number
  /** Operational log WITHOUT secrets (default console.warn). */
  log?: (message: string) => void
  /** Failed approvals allowed per email and per client IP in 10 minutes. */
  limits?: { perEmail?: number; perIp?: number }
}) => {
  const now = deps.now || Date.now
  const log = deps.log || ((message: string) => console.warn(`[agent] ${message}`))
  const lock = makeLocks()
  const byEmail = makeFailureLimiter(deps.limits?.perEmail ?? 5, 10 * 60_000, now)
  const byIp = makeFailureLimiter(deps.limits?.perIp ?? 30, 10 * 60_000, now)

  const checkProfile = (profile: SellerProfile) => {
    if (profile.banned) throw new SellerRejectedError(DISABLED)
    if (!SELLER_ROLES.has(profile.role)) throw new SellerRejectedError(NO_ROLE)
  }

  const signOutQuietly = async (accessToken: string, sessionId: string) => {
    try {
      await deps.auth.signOut(accessToken)
      return true
    } catch {
      log(`no se pudo cerrar la sesión de Supabase de la vinculación ${sessionId}; ya está revocada en el POS`)
      return false
    }
  }

  // Refresh and revoke share the per-session lock, and the record is re-read under it, so a
  // revocation can never be overwritten by a refresh that started earlier.
  const tokensFor = (sessionId: string): Promise<AuthTokens> => lock(`session:${sessionId}`, async () => {
    const session = await deps.store.getSession(sessionId)
    if (!session || session.revoked_at || session.expires_at <= now()) throw new SellerRejectedError(SESSION_INVALID)
    const current = deps.sealer.open<AuthTokens>(session.tokens_enc)
    if (current.expires_at * 1000 > now() + 60_000) return current
    let fresh: AuthTokens
    try {
      fresh = await deps.auth.refresh(current.refresh_token)
    } catch {
      throw new SellerRejectedError(SESSION_INVALID)
    }
    const latest = await deps.store.getSession(sessionId)
    if (!latest || latest.revoked_at) {
      await signOutQuietly(fresh.access_token, sessionId)
      throw new SellerRejectedError(SESSION_INVALID)
    }
    await deps.store.saveSession({ ...latest, tokens_enc: deps.sealer.seal(fresh) })
    return fresh
  })

  const loadSession = async (ref: string) => {
    const parts = splitRef(ref)
    const session = parts ? await deps.store.getSession(parts.id) : null
    if (!parts || !session || !sameHash(parts.secret, session.secret_hash)) throw new SellerRejectedError(SESSION_INVALID)
    if (session.revoked_at || session.expires_at <= now()) throw new SellerRejectedError(SESSION_INVALID)
    return session
  }

  /**
   * Revokes in the POS first (immediate effect), then closes the Supabase session with a
   * valid access token (refreshing it if needed). A failure to close it is logged and reported.
   */
  const revokeSession = (id: string): Promise<{ revoked: boolean; supabase_signed_out: boolean }> =>
    lock(`session:${id}`, async () => {
      const session = await deps.store.getSession(id)
      if (!session) return { revoked: false, supabase_signed_out: false }
      if (!session.revoked_at) await deps.store.saveSession({ ...session, revoked_at: now() })
      let tokens: AuthTokens
      try {
        tokens = deps.sealer.open<AuthTokens>(session.tokens_enc)
        if (tokens.expires_at * 1000 <= now() + 30_000) tokens = await deps.auth.refresh(tokens.refresh_token)
      } catch {
        // Refresh failed: the Supabase session is already invalid (or unreachable); nothing to close.
        log(`no se pudo renovar la sesión de Supabase de la vinculación ${id} para cerrarla; ya está revocada en el POS`)
        return { revoked: true, supabase_signed_out: false }
      }
      return { revoked: true, supabase_signed_out: await signOutQuietly(tokens.access_token, id) }
    })

  return {
    async start(verificationUrl: string) {
      const secret = randomBytes(32).toString('base64url')
      let code = newUserCode()
      while (await deps.store.findIdentificationByCode(normalizeUserCode(code))) code = newUserCode()
      const record: IdentificationRecord = {
        id: randomUUID(), secret_hash: sha256(secret).toString('hex'), user_code: code,
        status: 'pending', created_at: now(), expires_at: now() + IDENTIFICATION_TTL_SECONDS * 1000, failures: 0
      }
      await deps.store.saveIdentification(record)
      return {
        status: 'requires_identification' as const,
        identification_id: `${record.id}.${secret}`,
        user_code: code,
        verification_url: verificationUrl,
        expires_in: IDENTIFICATION_TTL_SECONDS
      }
    },

    /**
     * Connector polling. After approval the reference is delivered only with the number shown on
     * the /vincular page (match_code). 3 wrong numbers or the time running out deny the request
     * and revoke the session created at approval. approved → delivered is atomic (exactly once).
     */
    async status(handle: string, matchCode?: string) {
      const parts = splitRef(handle)
      if (!parts) return { status: 'denied' as const }
      return lock(`identification:${parts.id}`, async () => {
        const record = await deps.store.getIdentification(parts.id)
        if (!record || !sameHash(parts.secret, record.secret_hash)) return { status: 'denied' as const }
        if (record.status === 'denied') return { status: 'denied' as const }
        if (record.status === 'delivered') return { status: 'expired' as const }
        if (record.status === 'pending') return { status: record.expires_at <= now() ? 'expired' as const : 'pending' as const }
        // approved: waiting for the number shown on the page
        const fail = async <S extends 'expired' | 'denied'>(status: S) => {
          await deps.store.saveIdentification({ ...record, status: 'denied', session_ref_enc: undefined, match_hash: undefined })
          if (record.session_id) await revokeSession(record.session_id)
          return { status }
        }
        if (record.expires_at <= now()) return fail('expired')
        const given = String(matchCode || '').replace(/\D/g, '')
        if (!given) return { status: 'requires_match' as const }
        if (!record.match_hash || !sameHash(given, record.match_hash)) {
          const failures = (record.match_failures || 0) + 1
          if (failures >= MAX_MATCH_FAILURES) return fail('denied')
          await deps.store.saveIdentification({ ...record, match_failures: failures })
          return { status: 'match_mismatch' as const, attempts_left: MAX_MATCH_FAILURES - failures }
        }
        const session = deps.sealer.open<string>(record.session_ref_enc!)
        await deps.store.saveIdentification({ ...record, status: 'delivered', session_ref_enc: undefined, match_hash: undefined })
        return { status: 'approved' as const, session, seller: record.seller!, expires_at: Math.floor(record.session_expires_at! / 1000) }
      })
    },

    /** For /vincular: when the pending request was created, so the seller can spot a foreign code. */
    async lookup(userCode: string, ip = 'desconocida') {
      const code = normalizeUserCode(userCode)
      if (byIp.blocked(ip)) throw new IdentificationError(TOO_MANY)
      const record = code.length === 7 ? await deps.store.findIdentificationByCode(code) : null
      if (!record || record.status !== 'pending' || record.expires_at <= now()) {
        if (code.length === 7) byIp.fail(ip)
        throw new IdentificationError(INVALID_CODE)
      }
      return { requested_at: record.created_at, expires_at: record.expires_at }
    },

    /** Called from the POS page /vincular. Throws IdentificationError with a Spanish message. */
    async approve(userCode: string, email: string, password: string, ip = 'desconocida') {
      const code = normalizeUserCode(userCode)
      const mail = email.trim().toLowerCase()
      if (code.length !== 7 || !mail || !password) throw new IdentificationError('Completa el código, tu correo y tu contraseña.')
      // Failures per email are counted per email+IP: knowing someone's email does not let a
      // stranger lock that seller out from the shop. The message never reveals if the email exists.
      const mailKey = `${mail}|${ip}`
      if (byIp.blocked(ip) || byEmail.blocked(mailKey)) throw new IdentificationError(TOO_MANY)
      // One attempt per code at a time: failures are counted atomically (pending → approved/denied).
      return lock(`code:${code}`, async () => {
        const record = await deps.store.findIdentificationByCode(code)
        if (!record || record.status !== 'pending' || record.expires_at <= now()) {
          byIp.fail(ip)
          throw new IdentificationError(INVALID_CODE)
        }
        let tokens: AuthTokens
        try {
          tokens = await deps.auth.signIn(mail, password)
        } catch {
          byIp.fail(ip)
          byEmail.fail(mailKey)
          const failures = record.failures + 1
          await deps.store.saveIdentification({ ...record, failures, status: failures >= MAX_APPROVAL_FAILURES ? 'denied' : 'pending' })
          throw new IdentificationError(failures >= MAX_APPROVAL_FAILURES
            ? 'Demasiados intentos fallidos. El código quedó anulado; pide a Claude uno nuevo.'
            : 'Correo o contraseña incorrectos.')
        }
        let profile: SellerProfile
        try {
          profile = await deps.auth.profile(tokens.access_token)
          checkProfile(profile)
        } catch (error) {
          await signOutQuietly(tokens.access_token, record.id)
          await deps.store.saveIdentification({ ...record, status: 'denied' })
          throw new IdentificationError(error instanceof SellerRejectedError ? error.message : 'No se pudo comprobar tu usuario. Intenta de nuevo.')
        }
        const secret = randomBytes(32).toString('base64url')
        const session: SellerSessionRecord = {
          id: randomUUID(), secret_hash: sha256(secret).toString('hex'),
          user_id: profile.user_id, name: profile.name, role: profile.role,
          created_at: now(), expires_at: endOfWorkdayLima(now()), revoked_at: null,
          tokens_enc: deps.sealer.seal(tokens)
        }
        await deps.store.saveSession(session)
        const matchCode = String(randomInt(100, 1000))
        await deps.store.saveIdentification({
          ...record, status: 'approved', session_ref_enc: deps.sealer.seal(`${session.id}.${secret}`),
          seller: { name: profile.name, role: profile.role }, session_expires_at: session.expires_at,
          session_id: session.id, match_hash: sha256(matchCode).toString('hex'), match_failures: 0,
          expires_at: now() + MATCH_TTL_SECONDS * 1000
        })
        // Shown ONLY on the seller's /vincular page; it must be typed in the Claude chat.
        return { name: profile.name, role: profile.role, expires_at: session.expires_at, match_code: matchCode }
      })
    },

    /**
     * Resolves X-Yachay-Session into a validated seller, or throws SellerRejectedError.
     * name/role come from the CURRENT profile (checked on every request), never from approval
     * time: a manager demoted to cashier loses manager permissions on the next request.
     */
    async resolve(ref: string): Promise<ActiveSeller> {
      const session = await loadSession(ref)
      const check = async () => {
        const latest = await loadSession(ref)
        const tokens = await tokensFor(latest.id)
        let profile: SellerProfile
        try { profile = await deps.auth.profile(tokens.access_token) }
        catch { throw new SellerRejectedError(SESSION_INVALID) }
        if (profile.user_id !== latest.user_id) throw new SellerRejectedError(SESSION_INVALID)
        checkProfile(profile)
        // Last check right before handing out the token: a revocation always wins.
        await loadSession(ref)
        return { token: tokens.access_token, profile }
      }
      const authorize = async () => (await check()).token
      const { profile } = await check()
      if (profile.role !== session.role || profile.name !== session.name) {
        // Keep the POS list current; re-read under the session lock so a revocation is never lost.
        await lock(`session:${session.id}`, async () => {
          const latest = await deps.store.getSession(session.id)
          if (latest && !latest.revoked_at) await deps.store.saveSession({ ...latest, role: profile.role, name: profile.name })
        })
      }
      return { session_id: session.id, user_id: session.user_id, name: profile.name, role: profile.role, authorize }
    },

    async list() {
      const sessions = await deps.store.listSessions()
      return sessions
        .sort((a, b) => b.created_at - a.created_at)
        .map(s => ({
          id: s.id, name: s.name, role: s.role, created_at: s.created_at, expires_at: s.expires_at,
          revoked_at: s.revoked_at, active: !s.revoked_at && s.expires_at > now()
        }))
    },

    async revoke(id: string): Promise<{ revoked: boolean; supabase_signed_out: boolean }> {
      return revokeSession(id)
    }
  }
}

export type SellerSessions = ReturnType<typeof makeSellerSessions>
