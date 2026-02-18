export type AuthUser = {
  id: string
  email: string | null
}

export type AuthSession = {
  access_token: string
  refresh_token: string
  expires_in?: number | null
}

export type SignInResult = {
  session: AuthSession
  user: AuthUser
  role: string
}

export type SignUpResult = {
  session: AuthSession | null
  needsEmailConfirmation: boolean
  message: string
}

export type AuthRepository = {
  signIn(email: string, password: string): Promise<{ session: AuthSession; user: AuthUser }>
  signUp(input: { email: string; password: string; fullName: string }): Promise<{ session: AuthSession | null }>
  resolveRole(accessToken: string): Promise<string>
  getUser(accessToken: string): Promise<AuthUser | null>
  revokeSession(accessToken: string): Promise<void>
}

