export type UserRole = 'owner' | 'manager' | 'cashier'

export type Profile = {
  id: string
  full_name: string | null
  role: UserRole
}

export type UserRow = {
  id: string
  email: string | null
  created_at: string
  last_sign_in_at?: string | null
  profile?: Profile | null
}

export type CreateUserInput = {
  email: string
  password: string
  full_name?: string
  role?: UserRole
}

export type UpdateRoleInput = {
  currentUserId: string
  user_id: string
  role: UserRole
}

export type AdminRepository = {
  listUsers(): Promise<{ users: UserRow[] }>
  createUser(input: CreateUserInput): Promise<{ id: string }>
  updateRole(input: UpdateRoleInput): Promise<{ ok: true }>
}

