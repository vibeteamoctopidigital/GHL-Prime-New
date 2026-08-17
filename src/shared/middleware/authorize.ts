import type { RequestHandler } from 'express'
import type { UserRole } from '@prisma/client'
import ApiError from '../utils/ApiError.js'
import { CONTENT_MANAGER_ROLES, ROLES } from '../../config/constants.js'

/**
 * Role gate. Must run after `authenticate`.
 *
 *   router.delete('/:id', authenticate, authorize(ROLES.ADMIN), handler)
 */
export function authorize(...allowedRoles: (UserRole | UserRole[])[]): RequestHandler {
  const allowed = allowedRoles.flat()

  return (req, _res, next) => {
    if (!req.user) return next(ApiError.unauthorized('Authentication required'))

    if (allowed.length > 0 && !allowed.includes(req.user.role)) {
      return next(ApiError.forbidden('You do not have permission to perform this action'))
    }

    return next()
  }
}

/** Shorthand for the two roles allowed to manage site content. */
export const authorizeContentManager: RequestHandler = authorize(CONTENT_MANAGER_ROLES)

export const authorizeAdmin: RequestHandler = authorize(ROLES.ADMIN)

export default authorize
