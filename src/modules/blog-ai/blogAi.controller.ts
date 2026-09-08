import type { RequestHandler } from 'express'
import asyncHandler from '../../shared/utils/asyncHandler.js'
import { sendCreated, sendOk } from '../../shared/utils/ApiResponse.js'
import ApiError from '../../shared/utils/ApiError.js'
import blogAiService from './blogAi.service.js'
import blogAiDraftsService from './blogAi.drafts.service.js'
import { runBlogAiEngine } from './blogAi.engine.js'
import { decryptToken } from '../../shared/utils/tokenCrypto.js'
import { testOpenAiAccount, type TestResult } from './blogAi.providers.js'
import { testClaudeCliAccount, testCodexConnection, codexLoginStatus, codexLogout } from './blogAi.cliRunner.js'
import { startClaudeConnectSession, submitClaudeConnectCode, startCodexConnectSession } from './blogAi.cliConnect.js'
import { getConnectSession, destroyConnectSession, publicConnectSession } from './blogAi.connectSessions.js'
import type {
  AuthType,
  CreateAccountBody,
  ListDraftsQuery,
  ListRunsQuery,
  UpdateAccountBody,
  UpdateSettingsBody,
} from './blogAi.validators.js'

async function testAccountById(id: string): Promise<TestResult> {
  const account = await blogAiService.getAccountWithToken(id)
  if (!account) throw ApiError.notFound('Account not found')

  const token = decryptToken(account['token'] as string)
  const model = (account['model'] as string | null) || undefined

  if (account['provider'] === 'anthropic') {
    const settings = await blogAiService.getSettings()
    return testClaudeCliAccount({
      token,
      authType: account['auth_type'] as AuthType,
      model,
      cliPath: settings.claude_cli_command || undefined,
    })
  }

  // OpenAI account rows are always a plain API key (no per-account OAuth
  // concept here — that's what the ambient Codex login is for).
  return testOpenAiAccount({ apiKey: token, model })
}

export const blogAiController: Record<string, RequestHandler> = {
  getSettings: asyncHandler(async (_req, res) => {
    const data = await blogAiService.getSettings()
    return sendOk(res, data, 'Auto Blog settings retrieved')
  }),

  updateSettings: asyncHandler(async (req, res) => {
    const data = await blogAiService.saveSettings(req.body as UpdateSettingsBody)
    return sendOk(res, data, 'Auto Blog settings updated')
  }),

  listAccounts: asyncHandler(async (_req, res) => {
    const data = await blogAiService.listAccounts()
    return sendOk(res, data, 'Accounts retrieved')
  }),

  createAccount: asyncHandler(async (req, res) => {
    const data = await blogAiService.createAccount(req.body as CreateAccountBody)
    return sendCreated(res, { data, message: 'Account added successfully' })
  }),

  updateAccount: asyncHandler(async (req, res) => {
    const data = await blogAiService.updateAccount(req.params['id'] as string, req.body as UpdateAccountBody)
    return sendOk(res, data, 'Account updated successfully')
  }),

  removeAccount: asyncHandler(async (req, res) => {
    await blogAiService.deleteAccount(req.params['id'] as string)
    return sendOk(res, { id: req.params['id'], deleted: true }, 'Account deleted successfully')
  }),

  testAccount: asyncHandler(async (req, res) => {
    const result = await testAccountById(req.params['id'] as string)
    return sendOk(res, result, 'Account test complete')
  }),

  /** Tests every enabled account concurrently — one failing account can't reject the whole batch. */
  testAllAccounts: asyncHandler(async (_req, res) => {
    const accounts = await blogAiService.listAccounts()
    const enabled = accounts.filter((account) => account['enabled'] === true)

    const results = await Promise.all(
      enabled.map(async (account) => {
        const id = account['id'] as string
        try {
          const result = await testAccountById(id)
          return { accountId: id, label: account['label'], provider: account['provider'], ok: result.ok, message: result.message }
        } catch (error) {
          return {
            accountId: id,
            label: account['label'],
            provider: account['provider'],
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          }
        }
      }),
    )

    return sendOk(res, results, 'Account tests complete')
  }),

  runNow: asyncHandler(async (_req, res) => {
    const result = await runBlogAiEngine()
    if (!result.started) throw ApiError.conflict(result.reason ?? 'A run is already in progress')
    return sendOk(res, result, result.success ? 'Blog draft generated — awaiting review' : 'Blog AI run failed')
  }),

  listRuns: asyncHandler(async (req, res) => {
    const { limit } = req.query as ListRunsQuery
    const data = await blogAiService.listRuns(limit ?? 50)
    return sendOk(res, data, 'Run history retrieved')
  }),

  listDrafts: asyncHandler(async (req, res) => {
    const { status, limit } = req.query as ListDraftsQuery
    const data = await blogAiDraftsService.list(status, limit ?? 50)
    return sendOk(res, data, 'Drafts retrieved')
  }),

  getDraft: asyncHandler(async (req, res) => {
    const data = await blogAiDraftsService.findOrFail(req.params['id'] as string)
    return sendOk(res, data, 'Draft retrieved')
  }),

  approveDraft: asyncHandler(async (req, res) => {
    const data = await blogAiDraftsService.approveDraft(req.params['id'] as string, req.user!.id)
    return sendOk(res, data, 'Draft approved and published')
  }),

  rejectDraft: asyncHandler(async (req, res) => {
    const data = await blogAiDraftsService.rejectDraft(req.params['id'] as string, req.user!.id)
    return sendOk(res, data, 'Draft rejected')
  }),

  // -- Claude "connect from this browser" (no SSH, no local CLI) -----------
  //
  // Runs `claude setup-token` in a pty on the server, surfaces the OAuth
  // authorize URL it prints, accepts the resulting code, and — once the pty
  // exits successfully — saves the captured token via the exact same
  // saveConnectedAccount() the manual paste-token endpoint uses. See
  // blogAi.cliConnect.ts for the actual parsing/orchestration.

  startClaudeConnect: asyncHandler(async (req, res) => {
    const label = String((req.body as { label?: string } | undefined)?.label || '').trim()
    if (!label) throw ApiError.badRequest('Label is required')

    const settings = await blogAiService.getSettings()
    const session = startClaudeConnectSession({ label, cliPath: settings.claude_cli_command || undefined })
    return sendCreated(res, { data: { sessionId: session.id } })
  }),

  getClaudeConnect: asyncHandler(async (req, res) => {
    const session = getConnectSession(req.params['sessionId'] as string)
    if (!session) throw ApiError.notFound('Connect session not found or expired')
    return sendOk(res, publicConnectSession(session), 'Connect session status')
  }),

  submitClaudeConnectCode: asyncHandler(async (req, res) => {
    try {
      submitClaudeConnectCode(req.params['sessionId'] as string, (req.body as { code?: string } | undefined)?.code || '')
    } catch (error) {
      throw ApiError.badRequest(error instanceof Error ? error.message : String(error))
    }
    return sendOk(res, publicConnectSession(getConnectSession(req.params['sessionId'] as string)), 'Code submitted')
  }),

  deleteClaudeConnect: asyncHandler(async (req, res) => {
    destroyConnectSession(req.params['sessionId'] as string)
    return sendOk(res, { success: true }, 'Connect session cancelled')
  }),

  // -- Codex (single ambient-login connection, no accounts table rows) -----

  codexTest: asyncHandler(async (_req, res) => {
    const settings = await blogAiService.getSettings()
    const result = await testCodexConnection({ model: settings.openai_model || undefined, cliPath: settings.codex_cli_command || undefined })
    return sendOk(res, result, 'Codex test complete')
  }),

  // "Connect from this browser" — `codex login --device-auth` prints a URL
  // + one-time code and polls on its own until the admin approves in their
  // browser, so unlike Claude there's nothing to submit back; the frontend
  // just polls GET .../:sessionId until status is 'success'.
  startCodexConnect: asyncHandler(async (_req, res) => {
    const settings = await blogAiService.getSettings()
    const session = startCodexConnectSession({ cliPath: settings.codex_cli_command || undefined })
    return sendCreated(res, { data: { sessionId: session.id } })
  }),

  getCodexConnect: asyncHandler(async (req, res) => {
    const session = getConnectSession(req.params['sessionId'] as string)
    if (!session) throw ApiError.notFound('Connect session not found or expired')
    return sendOk(res, publicConnectSession(session), 'Connect session status')
  }),

  deleteCodexConnect: asyncHandler(async (req, res) => {
    destroyConnectSession(req.params['sessionId'] as string)
    return sendOk(res, { success: true }, 'Connect session cancelled')
  }),

  codexStatus: asyncHandler(async (_req, res) => {
    const settings = await blogAiService.getSettings()
    const status = await codexLoginStatus(settings.codex_cli_command || undefined)
    return sendOk(res, status, 'Codex login status')
  }),

  codexDisconnect: asyncHandler(async (_req, res) => {
    const settings = await blogAiService.getSettings()
    const result = await codexLogout(settings.codex_cli_command || undefined)
    return sendOk(res, result, 'Codex disconnected')
  }),
}

export default blogAiController
