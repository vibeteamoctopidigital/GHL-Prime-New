import { Router } from 'express'
import authenticate from '../../shared/middleware/authenticate.js'
import { authorizeAdmin } from '../../shared/middleware/authorize.js'
import validate from '../../shared/middleware/validate.js'
import { idParamSchema } from '../../shared/validators/common.validators.js'
import blogAiController from './blogAi.controller.js'
import {
  createAccountSchema,
  listDraftsQuerySchema,
  listRunsQuerySchema,
  updateAccountSchema,
  updateSettingsSchema,
} from './blogAi.validators.js'

const router = Router()

// Every route here manages API keys and triggers billable AI calls —
// admin-only end to end, unlike blog/case-studies there is no public read side.
router.use(authenticate, authorizeAdmin)

router.get('/settings', blogAiController.getSettings!)
router.put('/settings', validate({ body: updateSettingsSchema }), blogAiController.updateSettings!)

router.get('/accounts', blogAiController.listAccounts!)
router.post('/accounts', validate({ body: createAccountSchema }), blogAiController.createAccount!)
// Literal segment must precede '/:id' so 'test-all' is never captured as an :id.
router.post('/accounts/test-all', blogAiController.testAllAccounts!)
router.put('/accounts/:id', validate({ params: idParamSchema, body: updateAccountSchema }), blogAiController.updateAccount!)
router.delete('/accounts/:id', validate({ params: idParamSchema }), blogAiController.removeAccount!)
router.post('/accounts/:id/test', validate({ params: idParamSchema }), blogAiController.testAccount!)

// Claude "connect from this browser" — runs `claude setup-token` in a pty on
// the server; see blogAi.cliConnect.ts.
router.post('/accounts/connect/claude/start', blogAiController.startClaudeConnect!)
router.get('/accounts/connect/claude/:sessionId', blogAiController.getClaudeConnect!)
router.post('/accounts/connect/claude/:sessionId/code', blogAiController.submitClaudeConnectCode!)
router.delete('/accounts/connect/claude/:sessionId', blogAiController.deleteClaudeConnect!)

// Codex — single ambient `codex login --device-auth` session, no per-account rows.
router.post('/codex/test', blogAiController.codexTest!)
router.post('/codex/connect/start', blogAiController.startCodexConnect!)
router.get('/codex/connect/:sessionId', blogAiController.getCodexConnect!)
router.delete('/codex/connect/:sessionId', blogAiController.deleteCodexConnect!)
router.get('/codex/status', blogAiController.codexStatus!)
router.post('/codex/disconnect', blogAiController.codexDisconnect!)

// Manual trigger — real on-demand use, and the way to test the engine/cron
// gating logic without waiting for the next scheduled tick.
router.post('/run-now', blogAiController.runNow!)
router.get('/runs', validate({ query: listRunsQuerySchema }), blogAiController.listRuns!)

// Drafts — every generated post lands here first; it only ever becomes a
// real blog_posts row via approve (below) or the AI-checker sweep.
router.get('/drafts', validate({ query: listDraftsQuerySchema }), blogAiController.listDrafts!)
router.get('/drafts/:id', validate({ params: idParamSchema }), blogAiController.getDraft!)
router.post('/drafts/:id/approve', validate({ params: idParamSchema }), blogAiController.approveDraft!)
router.post('/drafts/:id/reject', validate({ params: idParamSchema }), blogAiController.rejectDraft!)

export default router
