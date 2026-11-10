import { getSupabaseAdminClient, getSupabaseAnonClient, getSupabaseUserClient } from '../../../utils/supabase'
import type { AuthTokens, SellerAuthGateway } from '../app/sellerSessions'

// The seller signs in with HIS/HER own credentials on the POS page; the POS keeps a dedicated
// Supabase session for Claude. Role checks run AS the seller (user_role RPC). The service key
// is used only to sign that dedicated session out on revocation, never to act as the seller.
const tokens = (session: { access_token: string; refresh_token: string; expires_at?: number; expires_in?: number } | null): AuthTokens => {
  if (!session?.access_token || !session.refresh_token) throw new Error('Sesión no disponible')
  const expiresAt = Number(session.expires_at) || Math.floor(Date.now() / 1000) + Number(session.expires_in || 3600)
  return { access_token: session.access_token, refresh_token: session.refresh_token, expires_at: expiresAt }
}

export const makeSupabaseSellerAuth = (): SellerAuthGateway => ({
  async signIn(email, password) {
    const { data, error } = await getSupabaseAnonClient().auth.signInWithPassword({ email, password })
    if (error) throw new Error('Credenciales inválidas')
    return tokens(data.session)
  },
  async refresh(refreshToken) {
    const { data, error } = await getSupabaseAnonClient().auth.refreshSession({ refresh_token: refreshToken })
    if (error) throw new Error('No se pudo renovar la sesión')
    return tokens(data.session)
  },
  async profile(accessToken) {
    const { data, error } = await getSupabaseAnonClient().auth.getUser(accessToken)
    if (error || !data.user) throw new Error('Usuario no válido')
    const user = data.user as typeof data.user & { banned_until?: string | null }
    const banned = Boolean(user.banned_until && Date.parse(user.banned_until) > Date.now())
    const client = getSupabaseUserClient(accessToken)
    const { data: role, error: roleError } = await client.rpc('user_role')
    if (roleError) throw new Error('No se pudo leer el rol')
    const { data: profile } = await client.from('profiles').select('full_name').eq('id', user.id).maybeSingle()
    const name = String(profile?.full_name || user.user_metadata?.full_name || user.email?.split('@')[0] || 'Vendedor').slice(0, 120)
    return { user_id: user.id, name, role: String(role || ''), banned }
  },
  async signOut(accessToken) {
    await getSupabaseAdminClient().auth.admin.signOut(accessToken, 'local')
  }
})
