import type { AuthenticatedUser } from './common.js'

/**
 * Augments Express's Request so `req.user` is typed everywhere downstream of
 * the authenticate middleware, instead of being cast at each call site.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthenticatedUser | null
    }
  }
}

export {}
