import type { H3Event } from 'h3'
import { createError, deleteCookie, getCookie, getHeader, setCookie } from 'h3'

import { getSupabaseAnonClient, getSupabaseUserClient } from './supabase'

const ACCESS_COOKIE = 'papeleria_at'
const REFRESH_COOKIE = 'papeleria_rt'

const decodeBase64Url = (value: string) => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(normalized, 'base64').toString('utf8')
}

const decodeJwtPayload = (jwt: string): Record<string, any> | null => {
  const parts = String(jwt || '').split('.')
  if (parts.length < 2) return null
  try {
    return JSON.parse(decodeBase64Url(parts[1]))
  } catch {
    return null
  }
}

const getJwtExp = (jwt: string): number | null => {
  const payload = decodeJwtPayload(jwt)
  const exp = payload?.exp
  return typeof exp === 'number' && Number.isFinite(exp) ? exp : null
}

const isJwtExpiringSoon = (jwt: string, withinSeconds = 60) => {
  const exp = getJwtExp(jwt)
  if (!exp) return false
  return exp * 1000 <= Date.now() + withinSeconds * 1000
}

const getCookieOptions = (event: H3Event) => {
  const forwardedProto = getHeader(event, 'x-forwarded-proto')
  const isHttps = forwardedProto === 'https' || (event.node.req.socket as any)?.encrypted === true

  return {
    httpOnly: true as const,
    secure: isHttps,
    sameSite: 'lax' as const,
    path: '/' as const
  }
}

export const setAuthCookies = (event: H3Event, session: { access_token: string; refresh_token: string; expires_in?: number | null }) => {
  const base = getCookieOptions(event)
  const accessMaxAge = Math.max(60, Number(session.expires_in || 60 * 60))
  const refreshMaxAge = 60 * 60 * 24 * 60 // 60 days

  setCookie(event, ACCESS_COOKIE, session.access_token, { ...base, maxAge: accessMaxAge })
  setCookie(event, REFRESH_COOKIE, session.refresh_token, { ...base, maxAge: refreshMaxAge })

  ;(event.context as any).papeleriaAccessToken = session.access_token
}

export const clearAuthCookies = (event: H3Event) => {
  deleteCookie(event, ACCESS_COOKIE, { path: '/' })
  deleteCookie(event, REFRESH_COOKIE, { path: '/' })

  delete (event.context as any).papeleriaAccessToken
  delete (event.context as any).papeleriaUserRole
  delete (event.context as any).papeleriaUserId
}

export const requireAccessToken = async (event: H3Event) => {
  const cached = (event.context as any).papeleriaAccessToken
  if (typeof cached === 'string' && cached) return cached

  let accessToken = String(getCookie(event, ACCESS_COOKIE) || '')
  const refreshToken = String(getCookie(event, REFRESH_COOKIE) || '')

  if (accessToken && refreshToken && isJwtExpiringSoon(accessToken, 60)) {
    accessToken = ''
  }

  if (accessToken) {
    ;(event.context as any).papeleriaAccessToken = accessToken
    return accessToken
  }

  if (!refreshToken) {
    throw createError({ statusCode: 401, statusMessage: 'No autenticado' })
  }

  const supabase = getSupabaseAnonClient()
  const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken })
  if (error || !data.session) {
    clearAuthCookies(event)
    throw createError({ statusCode: 401, statusMessage: error?.message || 'Sesión inválida' })
  }

  setAuthCookies(event, data.session)
  return data.session.access_token
}

export const getUserIdFromAccessToken = async (event: H3Event) => {
  const cached = (event.context as any).papeleriaUserId
  if (typeof cached === 'string' && cached) return cached

  const accessToken = await requireAccessToken(event)
  const sub = decodeJwtPayload(accessToken)?.sub
  if (typeof sub === 'string' && sub) {
    ;(event.context as any).papeleriaUserId = sub
    return sub
  }

  // Fallback to auth API if token is missing expected claims.
  const supabase = getSupabaseAnonClient()
  const { data, error } = await supabase.auth.getUser(accessToken)
  if (error || !data.user?.id) {
    clearAuthCookies(event)
    throw createError({ statusCode: 401, statusMessage: error?.message || 'Token inválido' })
  }

  ;(event.context as any).papeleriaUserId = data.user.id
  return data.user.id
}

export const getUserRole = async (event: H3Event) => {
  const cached = (event.context as any).papeleriaUserRole
  if (typeof cached === 'string' && cached) return cached

  const accessToken = await requireAccessToken(event)
  const supabase = getSupabaseUserClient(accessToken)

  // Prefer security definer RPC if available.
  const { data: roleData, error: roleError } = await supabase.rpc('user_role')
  if (!roleError && typeof roleData === 'string' && roleData) {
    ;(event.context as any).papeleriaUserRole = roleData
    return roleData
  }

  // Fallback to profiles lookup.
  const userId = await getUserIdFromAccessToken(event)
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .single()

  if (error) {
    if (roleError) {
      throw createError({ statusCode: 500, statusMessage: roleError.message })
    }
    throw createError({ statusCode: 500, statusMessage: error.message })
  }

  const role = String(profile?.role || '')
  ;(event.context as any).papeleriaUserRole = role
  return role
}

export const requireOwner = async (event: H3Event) => {
  const role = await getUserRole(event)
  if (role !== 'owner') {
    throw createError({ statusCode: 403, statusMessage: 'Acceso denegado' })
  }
  const accessToken = await requireAccessToken(event)
  const userId = await getUserIdFromAccessToken(event)
  return { accessToken, userId, role }
}

