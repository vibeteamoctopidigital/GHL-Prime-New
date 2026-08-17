import type { CookieOptions, Request, RequestHandler, Response } from 'express'
import env from '../../config/env.js'
import asyncHandler from '../../shared/utils/asyncHandler.js'
import { sendCreated, sendOk } from '../../shared/utils/ApiResponse.js'
import { expiresInToMs } from '../../shared/utils/token.js'
import authService, { type Session } from './auth.service.js'
import type { ChangePasswordBody, LoginBody, RegisterBody, UpdateUserBody } from './auth.validators.js'

const REFRESH_COOKIE = 'refreshToken'

const cookieOptions = (): CookieOptions => ({
  httpOnly: true,
  secure: env.isProduction,
  sameSite: env.isProduction ? 'none' : 'lax',
  maxAge: expiresInToMs(env.JWT_REFRESH_EXPIRES_IN),
  path: '/',
})

const requestContext = (req: Request) => ({
  userAgent: req.headers['user-agent'] ?? null,
  ipAddress: req.ip ?? null,
})

/**
 * The refresh token is returned in the body AND set as an httpOnly cookie:
 * the cookie is the safe default for browsers, the body value keeps
 * non-browser clients (Thunder tests, mobile) working.
 */
function withRefreshCookie(res: Response, session: Session): Session {
  res.cookie(REFRESH_COOKIE, session.refresh_token, cookieOptions())
  return session
}

const readRefreshToken = (req: Request): string | null =>
  (req.body as { refreshToken?: string })?.refreshToken ?? (req.cookies?.[REFRESH_COOKIE] as string | undefined) ?? null

export interface AuthController {
  register: RequestHandler
  login: RequestHandler
  refresh: RequestHandler
  logout: RequestHandler
  me: RequestHandler
  changePassword: RequestHandler
  listUsers: RequestHandler
  updateUser: RequestHandler
  deleteUser: RequestHandler
}

export const authController: AuthController = {
  register: asyncHandler(async (req, res) => {
    const user = await authService.register(req.body as RegisterBody)
    return sendCreated(res, { data: user, message: 'Account created successfully' })
  }),

  login: asyncHandler(async (req, res) => {
    const session = await authService.login(req.body as LoginBody, requestContext(req))
    return sendOk(res, withRefreshCookie(res, session), 'Signed in successfully')
  }),

  refresh: asyncHandler(async (req, res) => {
    const session = await authService.refresh(readRefreshToken(req), requestContext(req))
    return sendOk(res, withRefreshCookie(res, session), 'Session refreshed successfully')
  }),

  logout: asyncHandler(async (req, res) => {
    const data = await authService.logout({
      refreshToken: readRefreshToken(req),
      userId: req.user?.id,
    })

    res.clearCookie(REFRESH_COOKIE, { ...cookieOptions(), maxAge: undefined })
    return sendOk(res, data, 'Signed out successfully')
  }),

  /** GET /auth/me — used by the admin panel to restore a session on load. */
  me: asyncHandler(async (req, res) => {
    const user = await authService.getProfile(req.user!.id)
    return sendOk(res, { user }, 'Session retrieved')
  }),

  changePassword: asyncHandler(async (req, res) => {
    const data = await authService.changePassword(req.user!.id, req.body as ChangePasswordBody)
    return sendOk(res, data, 'Password changed successfully')
  }),

  listUsers: asyncHandler(async (_req, res) => {
    const data = await authService.listUsers()
    return sendOk(res, data, 'Users retrieved')
  }),

  updateUser: asyncHandler(async (req, res) => {
    const data = await authService.updateUser(req.params['id'] as string, req.body as UpdateUserBody)
    return sendOk(res, data, 'User updated successfully')
  }),

  deleteUser: asyncHandler(async (req, res) => {
    const data = await authService.deleteUser(req.params['id'] as string)
    return sendOk(res, data, 'User deleted successfully')
  }),
}

export default authController
