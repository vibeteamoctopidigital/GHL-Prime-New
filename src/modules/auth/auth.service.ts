import prisma from '../../config/prisma.js'
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
const PUBLIC_USER_SELECT = { id: true, email: true, full_name: true, role: true, is_active: true, last_login_at: true, created_at: true }

/** True for Prisma's "record to update/delete not found" error (P2025) — unlike PostgREST, update()/delete() throw instead of returning null. */
const isPrismaNotFound = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'P2025'

interface UserRow {
  id: string
  email: string
  password_hash?: string
  full_name: string | null
  role: UserRole
  is_active: boolean
  last_login_at?: Date | string | null
  created_at?: Date | string | null
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

const toIsoOrNull = (value: Date | string | null | undefined): string | null =>
  value == null ? null : value instanceof Date ? value.toISOString() : value

function toSessionUser(user: UserRow): SessionUser {
  return {
    id: user.id,
    email: user.email,
    full_name: user.full_name ?? null,
    role: user.role,
    is_active: user.is_active,
    last_login_at: toIsoOrNull(user.last_login_at),
    created_at: toIsoOrNull(user.created_at),
  }
}

class AuthService {
  /** Issues an access/refresh pair and persists the refresh token's digest. */
  async issueSession(user: UserRow, context: RequestContext = {}): Promise<Session> {
    const accessToken = signAccessToken({ sub: user.id, email: user.email, role: user.role })
    const refreshToken = signRefreshToken({ sub: user.id })

    try {
      await prisma.refreshToken.create({
        data: {
          token_hash: hashToken(refreshToken),
          user_id: user.id,
          expires_at: new Date(Date.now() + expiresInToMs(env.JWT_REFRESH_EXPIRES_IN)),
          user_agent: context.userAgent ?? null,
          ip_address: context.ipAddress ?? null,
        },
      })
    } catch (error) {
      throw ApiError.internal(`Could not start a session: ${error instanceof Error ? error.message : String(error)}`)
    }

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

    const existing = await prisma.user.findFirst({ where: { email: normalizedEmail }, select: { id: true } })
    if (existing) throw ApiError.conflict('An account with this email already exists')

    let created: UserRow
    try {
      created = await prisma.user.create({
        data: {
          email: normalizedEmail,
          password_hash: await hashPassword(password),
          full_name: fullName ?? null,
          role,
        },
        select: PUBLIC_USER_SELECT,
      })
    } catch (error) {
      throw ApiError.internal(`Could not create the account: ${error instanceof Error ? error.message : String(error)}`)
    }

    return toSessionUser(created)
  }

  async login({ email, password }: LoginInput, context: RequestContext = {}): Promise<Session> {
    const row = await prisma.user.findFirst({ where: { email: normalizeEmail(email) } })

    // Identical message for "no such user" and "wrong password" so the endpoint
    // cannot be used to enumerate accounts.
    if (!row || !(await comparePassword(password, row.password_hash ?? ''))) {
      throw ApiError.unauthorized('Invalid email or password')
    }

    if (!row.is_active) throw ApiError.forbidden('Account has been deactivated')

    const lastLoginAt = new Date()
    await prisma.user.update({ where: { id: row.id }, data: { last_login_at: lastLoginAt } })

    return this.issueSession({ ...row, last_login_at: lastLoginAt }, context)
  }

  /** Rotates the refresh token: the presented one is revoked as it is spent. */
  async refresh(refreshToken: string | null, context: RequestContext = {}): Promise<Session> {
    if (!refreshToken) throw ApiError.unauthorized('Refresh token is required')

    const payload = verifyRefreshToken(refreshToken)

    const record = await prisma.refreshToken.findFirst({
      where: { token_hash: hashToken(refreshToken) },
      include: { user: true },
    })

    if (!record || record.revoked_at || record.expires_at < new Date()) {
      throw ApiError.unauthorized('Refresh token is invalid or has expired')
    }

    if (record.user_id !== payload.sub) throw ApiError.unauthorized('Refresh token does not match its owner')
    if (!record.user?.is_active) throw ApiError.forbidden('Account has been deactivated')

    await prisma.refreshToken.update({ where: { id: record.id }, data: { revoked_at: new Date() } })

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
    const revokedAt = new Date()

    if (refreshToken) {
      await prisma.refreshToken.updateMany({
        where: { token_hash: hashToken(refreshToken), revoked_at: null },
        data: { revoked_at: revokedAt },
      })
    } else if (userId) {
      await prisma.refreshToken.updateMany({ where: { user_id: userId, revoked_at: null }, data: { revoked_at: revokedAt } })
    }

    return { signed_out: true }
  }

  async getProfile(userId: string): Promise<SessionUser> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: PUBLIC_USER_SELECT })

    if (!user) throw ApiError.notFound('User not found')
    return toSessionUser(user)
  }

  async changePassword(
    userId: string,
    { currentPassword, newPassword }: { currentPassword: string; newPassword: string },
  ): Promise<{ password_changed: true }> {
    const user = await prisma.user.findUnique({ where: { id: userId } })
    if (!user) throw ApiError.notFound('User not found')

    if (!(await comparePassword(currentPassword, user.password_hash ?? ''))) {
      throw ApiError.unauthorized('Current password is incorrect')
    }

    await prisma.user.update({ where: { id: userId }, data: { password_hash: await hashPassword(newPassword) } })

    // A password change invalidates every existing session.
    await prisma.refreshToken.updateMany({ where: { user_id: userId, revoked_at: null }, data: { revoked_at: new Date() } })

    return { password_changed: true }
  }

  async listUsers(): Promise<SessionUser[]> {
    const rows = await prisma.user.findMany({ select: PUBLIC_USER_SELECT, orderBy: { created_at: 'asc' } })
    return rows.map((row) => toSessionUser(row))
  }

  async updateUser(
    id: string,
    {
      role,
      isActive,
      fullName,
    }: { role?: UserRole | undefined; isActive?: boolean | undefined; fullName?: string | undefined },
  ): Promise<SessionUser> {
    let updated: UserRow
    try {
      updated = await prisma.user.update({
        where: { id },
        data: {
          ...(role !== undefined ? { role } : {}),
          ...(isActive !== undefined ? { is_active: isActive } : {}),
          ...(fullName !== undefined ? { full_name: fullName } : {}),
        },
        select: PUBLIC_USER_SELECT,
      })
    } catch (error) {
      if (isPrismaNotFound(error)) throw ApiError.notFound('User not found')
      throw ApiError.internal(`Could not update the user: ${error instanceof Error ? error.message : String(error)}`)
    }

    return toSessionUser(updated)
  }

  async deleteUser(id: string): Promise<{ id: string; deleted: true }> {
    try {
      await prisma.user.delete({ where: { id } })
    } catch (error) {
      if (isPrismaNotFound(error)) throw ApiError.notFound('User not found')
      throw ApiError.internal(`Could not delete the user: ${error instanceof Error ? error.message : String(error)}`)
    }

    return { id, deleted: true }
  }

  /** Housekeeping: clears expired/revoked tokens. Safe to run on a schedule. */
  async pruneExpiredTokens(): Promise<{ pruned: number }> {
    const { count } = await prisma.refreshToken.deleteMany({
      where: { OR: [{ expires_at: { lt: new Date() } }, { revoked_at: { not: null } }] },
    })

    return { pruned: count }
  }
}

export const authService = new AuthService()
export default authService
