import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

/**
 * Seller identification for the Yachay connector (device-flow style).
 *
 * 1. The connector asks to start: the POS returns an opaque identification handle (secret,
 *    only its hash is stored), a short user code and the link of THIS POS (/vincular).
 * 2. The seller opens the link, signs in with HIS/HER POS user and approves the code. The
 *    POS opens a dedicated Supabase session for the seller (never the service key).
 * 3. The connector polls with the handle and receives, ONCE, an opaque session reference.
 *    Every later call carries it in X-Yachay-Session; the POS re-validates the seller.
 *
 * No password, token or reference is ever logged or returned in error messages.
 */

export const SELLER_ROLES = new Set(['owner', 'manager', 'cashier'])
export const IDENTIFICATION_TTL_SECONDS = 600
export const MAX_APPROVAL_FAILURES = 5
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

export const makeSellerSessions = (deps: {
  store: SellerSessionStore
  auth: SellerAuthGateway
  sealer: ReturnType<typeof makeSealer>
  now?: () => number
}) => {
  const now = deps.now || Date.now
  const refreshing = new Map<string, Promise<AuthTokens>>()

  const checkProfile = (profile: SellerProfile) => {
    if (profile.banned) throw new SellerRejectedError(DISABLED)
    if (!SELLER_ROLES.has(profile.role)) throw new SellerRejectedError(NO_ROLE)
  }

  const tokensFor = async (session: SellerSessionRecord): Promise<AuthTokens> => {
    const current = deps.sealer.open<AuthTokens>(session.tokens_enc)
    if (current.expires_at * 1000 > now() + 60_000) return current
    // One refresh per session at a time: refresh tokens rotate.
    let pending = refreshing.get(session.id)
    if (!pending) {
      pending = (async () => {
        try {
          const fresh = await deps.auth.refresh(current.refresh_token)
          await deps.store.saveSession({ ...session, tokens_enc: deps.sealer.seal(fresh) })
          return fresh
        } catch {
          throw new SellerRejectedError(SESSION_INVALID)
        } finally {
          refreshing.delete(session.id)
        }
      })()
      refreshing.set(session.id, pending)
    }
    return pending
  }

  const loadSession = async (ref: string) => {
    const parts = splitRef(ref)
    const session = parts ? await deps.store.getSession(parts.id) : null
    if (!parts || !session || !sameHash(parts.secret, session.secret_hash)) throw new SellerRejectedError(SESSION_INVALID)
    if (session.revoked_at || session.expires_at <= now()) throw new SellerRejectedError(SESSION_INVALID)
    return session
  }

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

    async status(handle: string) {
      const parts = splitRef(handle)
      const record = parts ? await deps.store.getIdentification(parts.id) : null
      if (!parts || !record || !sameHash(parts.secret, record.secret_hash)) return { status: 'denied' as const }
      if (record.status === 'denied') return { status: 'denied' as const }
      // The session reference is delivered exactly once.
      if (record.status === 'delivered' || (record.status === 'pending' && record.expires_at <= now())) return { status: 'expired' as const }
      if (record.status === 'pending') return { status: 'pending' as const }
      const session = deps.sealer.open<string>(record.session_ref_enc!)
      await deps.store.saveIdentification({ ...record, status: 'delivered', session_ref_enc: undefined })
      return { status: 'approved' as const, session, seller: record.seller!, expires_at: Math.floor(record.session_expires_at! / 1000) }
    },

    /** Called from the POS page /vincular. Throws IdentificationError with a Spanish message. */
    async approve(userCode: string, email: string, password: string) {
      const code = normalizeUserCode(userCode)
      if (code.length !== 7 || !email.trim() || !password) throw new IdentificationError('Completa el código, tu correo y tu contraseña.')
      const record = await deps.store.findIdentificationByCode(code)
      if (!record || record.status !== 'pending' || record.expires_at <= now()) {
        throw new IdentificationError('El código no existe o venció. Pide a Claude un código nuevo.')
      }
      let tokens: AuthTokens
      try {
        tokens = await deps.auth.signIn(email.trim(), password)
      } catch {
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
        await deps.auth.signOut(tokens.access_token).catch(() => {})
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
      await deps.store.saveIdentification({
        ...record, status: 'approved', session_ref_enc: deps.sealer.seal(`${session.id}.${secret}`),
        seller: { name: profile.name, role: profile.role }, session_expires_at: session.expires_at
      })
      return { name: profile.name, role: profile.role, expires_at: session.expires_at }
    },

    /** Resolves X-Yachay-Session into a validated seller, or throws SellerRejectedError. */
    async resolve(ref: string): Promise<ActiveSeller> {
      const session = await loadSession(ref)
      const authorize = async () => {
        const latest = await loadSession(ref)
        const tokens = await tokensFor(latest)
        let profile: SellerProfile
        try { profile = await deps.auth.profile(tokens.access_token) }
        catch { throw new SellerRejectedError(SESSION_INVALID) }
        if (profile.user_id !== latest.user_id) throw new SellerRejectedError(SESSION_INVALID)
        checkProfile(profile)
        return tokens.access_token
      }
      await authorize()
      return { session_id: session.id, user_id: session.user_id, name: session.name, role: session.role, authorize }
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

    async revoke(id: string) {
      const session = await deps.store.getSession(id)
      if (!session) return false
      if (!session.revoked_at) {
        await deps.store.saveSession({ ...session, revoked_at: now() })
        try { await deps.auth.signOut(deps.sealer.open<AuthTokens>(session.tokens_enc).access_token) } catch {}
      }
      return true
    }
  }
}

export type SellerSessions = ReturnType<typeof makeSellerSessions>
