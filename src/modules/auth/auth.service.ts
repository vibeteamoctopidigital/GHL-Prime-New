import supabase from '../../config/supabase.js'
import env from '../../config/env.js'
import { UserRole } from '../../config/constants.js'
import ApiError from '../../shared/utils/ApiError.js'
import { comparePassword, hashPassword } from '../../shared/utils/password.js'
import {
  expiresInToMs,
  hashToken,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from '../../shared/utils/token.js'

/** Columns safe to return to a client. `password_hash` is never selected. */
const PUBLIC_USER_COLUMNS = 'id, email, full_name, role, is_active, last_login_at, created_at'

interface UserRow {
  id: string
  email: string
  password_hash?: string
  full_name: string | null
  role: UserRole
  is_active: boolean
  last_login_at?: string | null
  created_at?: string | null
}

/** The user shape the frontend session object expects (`session.user.email`). */
export interface SessionUser {
  id: string
  email: string
  full_name: string | null
  role: UserRole
  is_active: boolean
  last_login_at: string | null
  created_at: string | null
}

export interface Session {
  access_token: string
  refresh_token: string
  token_type: 'Bearer'
  expires_in: number
  user: SessionUser
}

export interface RequestContext {
  userAgent?: string | null
  ipAddress?: string | null
}

export interface RegisterInput {
  email: string
  password: string
  fullName?: string | undefined
  role?: UserRole | undefined
}

export interface LoginInput {
  email: string
  password: string
}

const normalizeEmail = (email: string): string => String(email).trim().toLowerCase()

function toSessionUser(user: UserRow): SessionUser {
  return {
    id: user.id,
    email: user.email,
    full_name: user.full_name ?? null,
    role: user.role,
    is_active: user.is_active,
    last_login_at: user.last_login_at ?? null,
    created_at: user.created_at ?? null,
  }
}

class AuthService {
  /** Issues an access/refresh pair and persists the refresh token's digest. */
  async issueSession(user: UserRow, context: RequestContext = {}): Promise<Session> {
    const accessToken = signAccessToken({ sub: user.id, email: user.email, role: user.role })
    const refreshToken = signRefreshToken({ sub: user.id })

    const { error } = await supabase.from('refresh_tokens').insert({
      token_hash: hashToken(refreshToken),
      user_id: user.id,
      expires_at: new Date(Date.now() + expiresInToMs(env.JWT_REFRESH_EXPIRES_IN)).toISOString(),
      user_agent: context.userAgent ?? null,
      ip_address: context.ipAddress ?? null,
    })

    if (error) throw ApiError.internal(`Could not start a session: ${error.message}`)

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: Math.floor(expiresInToMs(env.JWT_ACCESS_EXPIRES_IN) / 1000),
      user: toSessionUser(user),
    }
  }

  async register({ email, password, fullName, role = UserRole.EDITOR }: RegisterInput): Promise<SessionUser> {
    const normalizedEmail = normalizeEmail(email)

    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .eq('email', normalizedEmail)
      .maybeSingle()

    if (existing) throw ApiError.conflict('An account with this email already exists')

    const { data, error } = await supabase
      .from('users')
      .insert({
        email: normalizedEmail,
        password_hash: await hashPassword(password),
        full_name: fullName ?? null,
        role,
      })
      .select(PUBLIC_USER_COLUMNS)
      .single()

    if (error) throw ApiError.internal(`Could not create the account: ${error.message}`)

    return toSessionUser(data as UserRow)
  }

  async login({ email, password }: LoginInput, context: RequestContext = {}): Promise<Session> {
    const { data: user } = await supabase
      .from('users')
      .select('*')
      .eq('email', normalizeEmail(email))
      .maybeSingle()

    const row = user as UserRow | null

    // Identical message for "no such user" and "wrong password" so the endpoint
    // cannot be used to enumerate accounts.
    if (!row || !(await comparePassword(password, row.password_hash ?? ''))) {
      throw ApiError.unauthorized('Invalid email or password')
    }

    if (!row.is_active) throw ApiError.forbidden('Account has been deactivated')

    const lastLoginAt = new Date().toISOString()
    await supabase.from('users').update({ last_login_at: lastLoginAt }).eq('id', row.id)

    return this.issueSession({ ...row, last_login_at: lastLoginAt }, context)
  }

  /** Rotates the refresh token: the presented one is revoked as it is spent. */
  async refresh(refreshToken: string | null, context: RequestContext = {}): Promise<Session> {
    if (!refreshToken) throw ApiError.unauthorized('Refresh token is required')

    const payload = verifyRefreshToken(refreshToken)

    const { data: stored } = await supabase
      .from('refresh_tokens')
      .select('*, user:users(*)')
      .eq('token_hash', hashToken(refreshToken))
      .maybeSingle()

    const record = stored as
      | { id: string; user_id: string; revoked_at: string | null; expires_at: string; user: UserRow }
      | null

    if (!record || record.revoked_at || new Date(record.expires_at) < new Date()) {
      throw ApiError.unauthorized('Refresh token is invalid or has expired')
    }

    if (record.user_id !== payload.sub) throw ApiError.unauthorized('Refresh token does not match its owner')
    if (!record.user?.is_active) throw ApiError.forbidden('Account has been deactivated')

    await supabase.from('refresh_tokens').update({ revoked_at: new Date().toISOString() }).eq('id', record.id)

    return this.issueSession(record.user, context)
  }

  /** Revokes one refresh token, or every token for the user when none is given. */
  async logout({
    refreshToken,
    userId,
  }: {
    refreshToken?: string | null
    userId?: string | undefined
  }): Promise<{ signed_out: true }> {
    const revokedAt = new Date().toISOString()

    if (refreshToken) {
      await supabase
        .from('refresh_tokens')
        .update({ revoked_at: revokedAt })
        .eq('token_hash', hashToken(refreshToken))
        .is('revoked_at', null)
    } else if (userId) {
      await supabase.from('refresh_tokens').update({ revoked_at: revokedAt }).eq('user_id', userId).is('revoked_at', null)
    }

    return { signed_out: true }
  }

  async getProfile(userId: string): Promise<SessionUser> {
    const { data } = await supabase.from('users').select(PUBLIC_USER_COLUMNS).eq('id', userId).maybeSingle()

    if (!data) throw ApiError.notFound('User not found')
    return toSessionUser(data as UserRow)
  }

  async changePassword(
    userId: string,
    { currentPassword, newPassword }: { currentPassword: string; newPassword: string },
  ): Promise<{ password_changed: true }> {
    const { data } = await supabase.from('users').select('*').eq('id', userId).maybeSingle()
    const user = data as UserRow | null

    if (!user) throw ApiError.notFound('User not found')

    if (!(await comparePassword(currentPassword, user.password_hash ?? ''))) {
      throw ApiError.unauthorized('Current password is incorrect')
    }

    await supabase.from('users').update({ password_hash: await hashPassword(newPassword) }).eq('id', userId)

    // A password change invalidates every existing session.
    await supabase
      .from('refresh_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('user_id', userId)
      .is('revoked_at', null)

    return { password_changed: true }
  }

  async listUsers(): Promise<SessionUser[]> {
    const { data, error } = await supabase
      .from('users')
      .select(PUBLIC_USER_COLUMNS)
      .order('created_at', { ascending: true })

    if (error) throw ApiError.internal(`Could not list users: ${error.message}`)
    return (data ?? []).map((row) => toSessionUser(row as UserRow))
  }

  async updateUser(
    id: string,
    {
      role,
      isActive,
      fullName,
    }: { role?: UserRole | undefined; isActive?: boolean | undefined; fullName?: string | undefined },
  ): Promise<SessionUser> {
    const { data, error } = await supabase
      .from('users')
      .update({
        ...(role !== undefined ? { role } : {}),
        ...(isActive !== undefined ? { is_active: isActive } : {}),
        ...(fullName !== undefined ? { full_name: fullName } : {}),
      })
      .eq('id', id)
      .select(PUBLIC_USER_COLUMNS)
      .maybeSingle()

    if (error) throw ApiError.internal(`Could not update the user: ${error.message}`)
    if (!data) throw ApiError.notFound('User not found')

    return toSessionUser(data as UserRow)
  }

  async deleteUser(id: string): Promise<{ id: string; deleted: true }> {
    const { data, error } = await supabase.from('users').delete().eq('id', id).select('id').maybeSingle()

    if (error) throw ApiError.internal(`Could not delete the user: ${error.message}`)
    if (!data) throw ApiError.notFound('User not found')

    return { id, deleted: true }
  }

  /** Housekeeping: clears expired/revoked tokens. Safe to run on a schedule. */
  async pruneExpiredTokens(): Promise<{ pruned: number }> {
    const { data } = await supabase
      .from('refresh_tokens')
      .delete()
      .or(`expires_at.lt.${new Date().toISOString()},revoked_at.not.is.null`)
      .select('id')

    return { pruned: (data ?? []).length }
  }
}

export const authService = new AuthService()
export default authService
