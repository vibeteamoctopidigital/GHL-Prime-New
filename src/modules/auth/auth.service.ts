import type { User, UserRole } from '@prisma/client'
import prisma from '../../config/prisma.js'
import env from '../../config/env.js'
import { ROLES } from '../../config/constants.js'
import ApiError from '../../shared/utils/ApiError.js'
import { comparePassword, hashPassword } from '../../shared/utils/password.js'
import { expiresInToMs, hashToken, signAccessToken, signRefreshToken, verifyRefreshToken } from '../../shared/utils/token.js'

/** Fields safe to return to a client. `passwordHash` is never selected. */
const PUBLIC_USER_SELECT = {
  id: true,
  email: true,
  fullName: true,
  role: true,
  isActive: true,
  lastLoginAt: true,
  createdAt: true,
} as const

type PublicUser = Pick<User, 'id' | 'email' | 'fullName' | 'role' | 'isActive' | 'lastLoginAt' | 'createdAt'>

/** The user shape the frontend session object expects (`session.user.email`). */
export interface SessionUser {
  id: string
  email: string
  full_name: string | null
  role: UserRole
  is_active: boolean
  last_login_at: Date | null
  created_at: Date | null
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

function toSessionUser(user: PublicUser | User): SessionUser {
  return {
    id: user.id,
    email: user.email,
    full_name: user.fullName ?? null,
    role: user.role,
    is_active: user.isActive,
    last_login_at: user.lastLoginAt ?? null,
    created_at: user.createdAt ?? null,
  }
}

class AuthService {
  /** Issues an access/refresh pair and persists the refresh token's digest. */
  async issueSession(user: User | PublicUser, context: RequestContext = {}): Promise<Session> {
    const accessToken = signAccessToken({ sub: user.id, email: user.email, role: user.role })
    const refreshToken = signRefreshToken({ sub: user.id })

    await prisma.refreshToken.create({
      data: {
        tokenHash: hashToken(refreshToken),
        userId: user.id,
        expiresAt: new Date(Date.now() + expiresInToMs(env.JWT_REFRESH_EXPIRES_IN)),
        userAgent: context.userAgent ?? null,
        ipAddress: context.ipAddress ?? null,
      },
    })

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: Math.floor(expiresInToMs(env.JWT_ACCESS_EXPIRES_IN) / 1000),
      user: toSessionUser(user),
    }
  }

  async register({ email, password, fullName, role = ROLES.EDITOR }: RegisterInput): Promise<SessionUser> {
    const normalizedEmail = normalizeEmail(email)

    if (await prisma.user.findUnique({ where: { email: normalizedEmail } })) {
      throw ApiError.conflict('An account with this email already exists')
    }

    const user = await prisma.user.create({
      data: {
        email: normalizedEmail,
        passwordHash: await hashPassword(password),
        fullName: fullName ?? null,
        role,
      },
      select: PUBLIC_USER_SELECT,
    })

    return toSessionUser(user)
  }

  async login({ email, password }: LoginInput, context: RequestContext = {}): Promise<Session> {
    const user = await prisma.user.findUnique({ where: { email: normalizeEmail(email) } })

    // Identical message for "no such user" and "wrong password" so the endpoint
    // cannot be used to enumerate accounts.
    if (!user || !(await comparePassword(password, user.passwordHash))) {
      throw ApiError.unauthorized('Invalid email or password')
    }

    if (!user.isActive) throw ApiError.forbidden('Account has been deactivated')

    const lastLoginAt = new Date()
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt } })

    return this.issueSession({ ...user, lastLoginAt }, context)
  }

  /** Rotates the refresh token: the presented one is revoked as it is spent. */
  async refresh(refreshToken: string | null, context: RequestContext = {}): Promise<Session> {
    if (!refreshToken) throw ApiError.unauthorized('Refresh token is required')

    const payload = verifyRefreshToken(refreshToken)

    const stored = await prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(refreshToken) },
      include: { user: true },
    })

    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw ApiError.unauthorized('Refresh token is invalid or has expired')
    }

    if (stored.userId !== payload.sub) throw ApiError.unauthorized('Refresh token does not match its owner')
    if (!stored.user.isActive) throw ApiError.forbidden('Account has been deactivated')

    await prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } })

    return this.issueSession(stored.user, context)
  }

  /** Revokes one refresh token, or every token for the user when none is given. */
  async logout({ refreshToken, userId }: { refreshToken?: string | null; userId?: string | undefined }): Promise<{ signed_out: true }> {
    if (refreshToken) {
      await prisma.refreshToken.updateMany({
        where: { tokenHash: hashToken(refreshToken), revokedAt: null },
        data: { revokedAt: new Date() },
      })
    } else if (userId) {
      await prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } })
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

    if (!(await comparePassword(currentPassword, user.passwordHash))) {
      throw ApiError.unauthorized('Current password is incorrect')
    }

    await prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(newPassword) } })

    // A password change invalidates every existing session.
    await prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } })

    return { password_changed: true }
  }

  async listUsers(): Promise<SessionUser[]> {
    const users = await prisma.user.findMany({ select: PUBLIC_USER_SELECT, orderBy: { createdAt: 'asc' } })
    return users.map(toSessionUser)
  }

  async updateUser(
    id: string,
    { role, isActive, fullName }: { role?: UserRole | undefined; isActive?: boolean | undefined; fullName?: string | undefined },
  ): Promise<SessionUser> {
    const user = await prisma.user.update({
      where: { id },
      data: {
        ...(role !== undefined ? { role } : {}),
        ...(isActive !== undefined ? { isActive } : {}),
        ...(fullName !== undefined ? { fullName } : {}),
      },
      select: PUBLIC_USER_SELECT,
    })

    return toSessionUser(user)
  }

  async deleteUser(id: string): Promise<{ id: string; deleted: true }> {
    await prisma.user.delete({ where: { id } })
    return { id, deleted: true }
  }

  /** Housekeeping: clears expired/revoked tokens. Safe to run on a schedule. */
  async pruneExpiredTokens(): Promise<{ pruned: number }> {
    const { count } = await prisma.refreshToken.deleteMany({
      where: { OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { not: null } }] },
    })

    return { pruned: count }
  }
}

export const authService = new AuthService()
export default authService
