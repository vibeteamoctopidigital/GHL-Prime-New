import { Router } from 'express'
import validate from '../../shared/middleware/validate.js'
import authenticate from '../../shared/middleware/authenticate.js'
import { authorizeAdmin } from '../../shared/middleware/authorize.js'
import { authLimiter } from '../../shared/middleware/rateLimiter.js'
import { idParamSchema } from '../../shared/validators/common.validators.js'
import authController from './auth.controller.js'
import createModuleIndex from '../../shared/factories/createModuleIndex.js'
import {
  changePasswordSchema,
  loginSchema,
  logoutSchema,
  refreshSchema,
  registerSchema,
  updateUserSchema,
} from './auth.validators.js'

const router = Router()

/** GET /auth — lists what lives under this prefix. */
router.get('/', createModuleIndex('/auth', [
  {
    "method": "POST",
    "path": "/login",
    "description": "Exchange credentials for tokens"
  },
  {
    "method": "POST",
    "path": "/refresh",
    "description": "Rotate the token pair"
  },
  {
    "method": "POST",
    "path": "/logout",
    "description": "Revoke the refresh token"
  },
  {
    "method": "GET",
    "path": "/me",
    "description": "Current user (auth)"
  },
  {
    "method": "GET",
    "path": "/session",
    "description": "Alias of /me (auth)"
  },
  {
    "method": "POST",
    "path": "/change-password",
    "description": "Change own password (auth)"
  },
  {
    "method": "POST",
    "path": "/register",
    "description": "Create a user (admin)"
  },
  {
    "method": "GET",
    "path": "/users",
    "description": "List users (admin)"
  },
  {
    "method": "PATCH",
    "path": "/users/:id",
    "description": "Update a user (admin)"
  },
  {
    "method": "DELETE",
    "path": "/users/:id",
    "description": "Delete a user (admin)"
  }
]))

// --- Public (rate limited) --------------------------------------------------
router.post('/login', authLimiter, validate({ body: loginSchema }), authController.login)
router.post('/refresh', authLimiter, validate({ body: refreshSchema }), authController.refresh)
router.post('/logout', validate({ body: logoutSchema }), authController.logout)

// --- Authenticated ----------------------------------------------------------
router.get('/me', authenticate, authController.me)
router.get('/session', authenticate, authController.me)
router.post('/change-password', authenticate, validate({ body: changePasswordSchema }), authController.changePassword)

// --- Admin-only user management --------------------------------------------
router.post('/register', authenticate, authorizeAdmin, validate({ body: registerSchema }), authController.register)
router.get('/users', authenticate, authorizeAdmin, authController.listUsers)
router.patch(
  '/users/:id',
  authenticate,
  authorizeAdmin,
  validate({ params: idParamSchema, body: updateUserSchema }),
  authController.updateUser,
)
router.delete('/users/:id', authenticate, authorizeAdmin, validate({ params: idParamSchema }), authController.deleteUser)

export default router
