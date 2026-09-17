import { Router } from 'express'
import authenticate from '../../shared/middleware/authenticate.js'
import { authorizeAdmin } from '../../shared/middleware/authorize.js'
import validate from '../../shared/middleware/validate.js'
import asyncHandler from '../../shared/utils/asyncHandler.js'
import { sendOk } from '../../shared/utils/ApiResponse.js'
import createModuleIndex from '../../shared/factories/createModuleIndex.js'
import * as claudeAuthService from './claudeAuth.service.js'
import { submitCodeSchema } from './claudeAuth.validators.js'

const router = Router()

router.get('/', createModuleIndex('/claude-auth', [
  { method: 'GET', path: '/status', description: 'Which Anthropic account the claude CLI is logged into + login-session state (drives the admin Claude Account card)' },
  { method: 'POST', path: '/login', description: 'Start `claude setup-token` in a PTY and capture the OAuth URL for the admin to open in a browser' },
  { method: 'GET', path: '/login', description: 'Poll the running login session — returns the captured URL and the latest terminal output' },
  { method: 'POST', path: '/login/code', description: 'Submit the OAuth code the admin got back from the browser' },
  { method: 'DELETE', path: '/login', description: 'Cancel an in-flight login session without changing the stored credentials' },
  { method: 'POST', path: '/logout', description: 'Run `claude auth logout` — clears the stored Anthropic login' },
]))

// Everything here manages the credential the Blog Writer runs under — strictly
// admin-only, same as /blog-writer.
router.use(authenticate, authorizeAdmin)

router.get('/status', asyncHandler(async (_req, res) => {
  const status = await claudeAuthService.getStatus()
  return sendOk(res, status)
}))

router.post('/login', asyncHandler(async (_req, res) => {
  const result = claudeAuthService.startLogin()
  if (!result.ok) {
    return sendOk(res, { started: false, error: result.error }, 'Could not start login')
  }
  return sendOk(res, { started: true, url: result.url }, 'Login session started — open the URL, then submit the code')
}))

router.get('/login', asyncHandler(async (_req, res) => {
  const status = await claudeAuthService.getStatus()
  return sendOk(res, { ...status.login, loggedIn: status.loggedIn, pty_available: status.pty_available })
}))

router.post('/login/code', validate({ body: submitCodeSchema }), asyncHandler(async (req, res) => {
  const result = claudeAuthService.submitLoginCode(req.body.code as string)
  if (!result.ok) {
    return sendOk(res, { accepted: false, error: result.error }, 'Code not accepted')
  }
  return sendOk(res, { accepted: true }, 'Code submitted — poll /status to confirm the login completed')
}))

router.delete('/login', asyncHandler(async (_req, res) => {
  claudeAuthService.cancelLogin()
  return sendOk(res, null, 'Login session cancelled')
}))

router.post('/logout', asyncHandler(async (_req, res) => {
  const result = await claudeAuthService.logout()
  return sendOk(res, result, 'Logged out of the Anthropic account')
}))

export default router
