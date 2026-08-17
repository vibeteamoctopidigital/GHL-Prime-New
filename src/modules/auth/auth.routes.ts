import { Router } from 'express'
import validate from '../../shared/middleware/validate.js'
import authenticate from '../../shared/middleware/authenticate.js'
import { authorizeAdmin } from '../../shared/middleware/authorize.js'
import { authLimiter } from '../../shared/middleware/rateLimiter.js'
import { idParamSchema } from '../../shared/validators/common.validators.js'
import authController from './auth.controller.js'
import {
  changePasswordSchema,
  loginSchema,
  logoutSchema,
  refreshSchema,
  registerSchema,
  updateUserSchema,
} from './auth.validators.js'

const router = Router()

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
