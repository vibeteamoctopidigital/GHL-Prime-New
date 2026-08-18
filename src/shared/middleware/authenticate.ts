import type { RequestHandler } from 'express'
import supabase from '../../config/supabase.js'
import ApiError from '../utils/ApiError.js'
import asyncHandler from '../utils/asyncHandler.js'
import { extractBearerToken, verifyAccessToken } from '../utils/token.js'
import type { AuthenticatedUser } from '../../types/common.js'

const USER_COLUMNS = 'id, email, full_name, role, is_active'

async function resolveUser(token: string): Promise<AuthenticatedUser> {
  const payload = verifyAccessToken(token)

  const { data } = await supabase.from('users').select(USER_COLUMNS).eq('id', payload.sub).maybeSingle()
  const row = data as { id: string; email: string; full_name: string | null; role: AuthenticatedUser['role']; is_active: boolean } | null

  if (!row) throw ApiError.unauthorized('Account no longer exists')
  if (!row.is_active) throw ApiError.forbidden('Account has been deactivated')

  return { id: row.id, email: row.email, fullName: row.full_name, role: row.role, isActive: row.is_active }
}

const readToken = (req: Parameters<RequestHandler>[0]): string | null =>
  extractBearerToken(req) ?? (req.cookies?.accessToken as string | undefined) ?? null

/** Rejects the request unless a valid access token is present. */
export const authenticate: RequestHandler = asyncHandler(async (req, _res, next) => {
  const token = readToken(req)
  if (!token) throw ApiError.unauthorized('Authentication required')

  req.user = await resolveUser(token)
  next()
})

/**
 * Attaches `req.user` when a valid token is present but never rejects.
 * Used on public read endpoints so admins can additionally see drafts —
 * the behaviour the old Supabase "authenticated can read all" RLS policy gave.
 */
export const optionalAuthenticate: RequestHandler = asyncHandler(async (req, _res, next) => {
  const token = readToken(req)

  if (token) {
    try {
      req.user = await resolveUser(token)
    } catch {
      req.user = null
    }
  }

  next()
})

export default authenticate
