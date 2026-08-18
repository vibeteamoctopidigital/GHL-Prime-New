import crypto from 'node:crypto'
import jwt, { type JwtPayload, type SignOptions } from 'jsonwebtoken'
import type { Request } from 'express'
import type { UserRole } from '../../config/constants.js'
import env from '../../config/env.js'
import ApiError from './ApiError.js'

const ACCESS = 'access'
const REFRESH = 'refresh'

const ISSUER = 'ghlprime-api'

export interface AccessTokenPayload {
  sub: string
  email: string
  role: UserRole
}

export interface RefreshTokenPayload {
  sub: string
}

type TokenType = typeof ACCESS | typeof REFRESH

/**
 * Signs a token that is tagged with its own type, so a refresh token can never
 * be replayed as an access token (or vice versa) even though both are JWTs.
 */
function sign(payload: object, secret: string, expiresIn: string, type: TokenType): string {
  return jwt.sign({ ...payload, type }, secret, { expiresIn, issuer: ISSUER } as SignOptions)
}

function verify<T>(token: string, secret: string, type: TokenType): T & JwtPayload {
  try {
    const decoded = jwt.verify(token, secret, { issuer: ISSUER }) as JwtPayload & { type?: string }

    if (decoded.type !== type) {
      throw ApiError.unauthorized(`Expected a ${type} token`)
    }

    return decoded as T & JwtPayload
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (error instanceof Error && error.name === 'TokenExpiredError') throw ApiError.unauthorized('Token has expired')
    throw ApiError.unauthorized('Invalid token')
  }
}

export const signAccessToken = (payload: AccessTokenPayload): string =>
  sign(payload, env.JWT_ACCESS_SECRET, env.JWT_ACCESS_EXPIRES_IN, ACCESS)

export const signRefreshToken = (payload: RefreshTokenPayload): string =>
  sign(payload, env.JWT_REFRESH_SECRET, env.JWT_REFRESH_EXPIRES_IN, REFRESH)

export const verifyAccessToken = (token: string): AccessTokenPayload & JwtPayload =>
  verify<AccessTokenPayload>(token, env.JWT_ACCESS_SECRET, ACCESS)

export const verifyRefreshToken = (token: string): RefreshTokenPayload & JwtPayload =>
  verify<RefreshTokenPayload>(token, env.JWT_REFRESH_SECRET, REFRESH)

/** Refresh tokens are persisted as SHA-256 digests, never in plaintext. */
export const hashToken = (token: string): string => crypto.createHash('sha256').update(String(token)).digest('hex')

/** Reads a bearer token from the Authorization header. */
export function extractBearerToken(req: Request): string | null {
  const header = req.headers?.authorization ?? ''
  if (!header.startsWith('Bearer ')) return null
  const token = header.slice('Bearer '.length).trim()
  return token || null
}

/** Converts "15m" / "30d" / "3600" into milliseconds — used for cookie maxAge. */
export function expiresInToMs(value: string): number {
  const match = /^(\d+)([smhd])?$/.exec(String(value).trim())
  if (!match?.[1]) return 0

  const amount = Number(match[1])
  const unit = (match[2] ?? 's') as 's' | 'm' | 'h' | 'd'
  const multipliers = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const

  return amount * multipliers[unit]
}

export default {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  hashToken,
  extractBearerToken,
  expiresInToMs,
}
