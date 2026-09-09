import fs from 'node:fs/promises'
import path from 'node:path'
import { stripAnsi } from '../../shared/utils/ansiStrip.js'
import logger from '../../shared/utils/logger.js'
import { createConnectSession, getConnectSession, updateConnectSession, type ConnectSession } from './blogAi.connectSessions.js'
import {
  spawnClaudeSetupToken,
  spawnCodexDeviceAuth,
  cleanupScratchDir,
  backupCredentialFile,
  restoreCredentialFile,
  discardCredentialBackup,
  CODEX_AUTH_PATH,
} from './blogAi.ptyRunner.js'
import blogAiService from './blogAi.service.js'

/**
 * TEMPORARY diagnostic — two prior fixes to extractClaudeToken() (a strict
 * sk-ant-oat pattern, then a broadened sk-ant- pattern) have both failed
 * against a real connect attempt (401 "access token is invalid" on the
 * saved account). Rather than guess a third regex, this logs the FULL
 * ANSI-stripped output AND a listing of whatever `claude setup-token`
 * actually left in its isolated CLAUDE_CONFIG_DIR scratch dir — server-side
 * only, never exposed to the frontend — right before that directory is
 * deleted. Check the server console after the next connect attempt; once
 * the real shape of a successful run is known, delete this block and fix
 * extractClaudeToken() (or switch to reading a credential file directly)
 * against actual evidence instead of another guess.
 */
async function logConnectDiagnostics(scratchDir: string, strippedOutput: string): Promise<void> {
  try {
    logger.info(`[blog-ai connect diagnostic] Full stripped output (${strippedOutput.length} chars):\n${strippedOutput}`)

    const entries = await fs.readdir(scratchDir, { withFileTypes: true }).catch(() => [])
    logger.info(`[blog-ai connect diagnostic] Scratch dir ${scratchDir} contains: ${entries.map((e) => e.name).join(', ') || '(empty)'}`)

    for (const entry of entries) {
      if (!entry.isFile()) continue
      const filePath = path.join(scratchDir, entry.name)
      try {
        const stat = await fs.stat(filePath)
        if (stat.size > 20_000) {
          logger.info(`[blog-ai connect diagnostic] ${entry.name}: ${stat.size} bytes, skipping dump (too large)`)
          continue
        }
        const content = await fs.readFile(filePath, 'utf8')
        logger.info(`[blog-ai connect diagnostic] ${entry.name} contents:\n${content}`)
      } catch (error) {
        logger.info(`[blog-ai connect diagnostic] Could not read ${entry.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  } catch (error) {
    logger.warn('[blog-ai connect diagnostic] Failed to collect diagnostics:', error instanceof Error ? error.message : error)
  }
}

/**
 * Orchestrates the two "connect from this browser" pty login flows on top
 * of blogAi.connectSessions.ts (generic session store) and
 * blogAi.ptyRunner.ts (raw pty process mechanics). This is the piece that
 * knows what `claude setup-token` and `codex login --device-auth` actually
 * print and how to react to it.
 */

const DEBUG_TAIL_CHARS = 4000
const VERIFY_TIMEOUT_MS = 45_000

// -- Claude `setup-token` ----------------------------------------------------
//
// Sequence: prints a welcome banner, tries (and fails, expected) to open a
// local browser, shows a spinner, then prints the OAuth authorize URL
// wrapped in an OSC-8 hyperlink, redrawing it periodically alongside the
// spinner. Then it prompts "Paste code here if prompted >" and waits for
// input. Token extraction below is best-effort — if the regex is wrong,
// `status` resolves to 'failed' with `debugTail` containing the
// ANSI-stripped tail of the real output, which is what's needed to fix the
// regex from a real capture.

const CLAUDE_AUTH_URL_PATTERN = /https:\/\/claude\.com\/cai\/oauth\/authorize\?[^\s]+/
// `claude setup-token` prints the token and never writes it to disk (verified
// against the CLI reference), so scraping the terminal is the only option.
// Deliberately STRICT: an earlier version fell back to "the last long
// alphanumeric run in the output", which happily matched a chunk of prose or
// an OAuth URL query parameter, stored it as if the connect had succeeded,
// and only surfaced much later as a baffling "401 OAuth access token is
// invalid" on the first real generation. A miss must fail loudly here, with
// debugTail carrying the real output, rather than silently saving garbage.
const CLAUDE_TOKEN_PATTERN = /sk-ant-[A-Za-z0-9_-]{20,}/g

function extractClaudeAuthUrl(strippedText: string): string | null {
  const match = strippedText.match(CLAUDE_AUTH_URL_PATTERN)
  return match ? match[0] : null
}

/** Last `sk-ant-…` match in the output — the freshly-printed token, not an earlier banner/example. */
function extractClaudeToken(strippedText: string): string | null {
  const matches = strippedText.match(CLAUDE_TOKEN_PATTERN)
  if (!matches?.length) return null
  return matches[matches.length - 1] ?? null
}

export function startClaudeConnectSession(opts: { label: string; cliPath?: string | undefined }): ConnectSession {
  const session = createConnectSession({ provider: 'claude', label: opts.label })
  let scratchDir: string | null = null

  // No credential backup/restore needed here — spawnClaudeSetupToken() runs
  // with CLAUDE_CONFIG_DIR pointed at its own disposable scratch dir, so it
  // never touches the real ~/.claude at all (see blogAi.ptyRunner.ts).
  spawnClaudeSetupToken(opts.cliPath)
    .then(({ ptyProcess, cwd }) => {
      scratchDir = cwd

      if (!getConnectSession(session.id)) {
        // Session was cancelled/expired before the pty even finished starting.
        ptyProcess.kill()
        void cleanupScratchDir(cwd)
        return
      }

      updateConnectSession(session.id, { ptyProcess, scratchDir: cwd })

      ptyProcess.onData((chunk) => {
        const current = getConnectSession(session.id)
        if (!current) return

        const outputBuffer = current.outputBuffer + chunk
        const patch: Record<string, unknown> = { outputBuffer }

        if (current.status === 'starting' && !current.url) {
          const url = extractClaudeAuthUrl(stripAnsi(outputBuffer))
          if (url) {
            patch['url'] = url
            patch['status'] = 'awaiting_code'
          }
        }

        updateConnectSession(session.id, patch)
      })

      ptyProcess.onExit(({ exitCode }) => {
        // Sequenced, not concurrent: diagnostics/token-extraction must read
        // the scratch dir before cleanup deletes it, not race it.
        void handleClaudeExit(session.id, exitCode, scratchDir).finally(() => {
          void cleanupScratchDir(scratchDir)
        })
      })
    })
    .catch((error: unknown) => {
      updateConnectSession(session.id, {
        status: 'failed',
        message: `Could not start "claude setup-token": ${error instanceof Error ? error.message : String(error)}`,
      })
    })

  return session
}

async function handleClaudeExit(sessionId: string, exitCode: number, scratchDir: string | null): Promise<void> {
  const session = getConnectSession(sessionId)
  if (!session) return

  const fullStrippedOutput = stripAnsi(session.outputBuffer)
  const strippedTail = fullStrippedOutput.slice(-DEBUG_TAIL_CHARS)

  if (scratchDir) await logConnectDiagnostics(scratchDir, fullStrippedOutput)

  if (exitCode !== 0) {
    updateConnectSession(sessionId, {
      status: 'failed',
      message: `"claude setup-token" exited with code ${exitCode}`,
      debugTail: strippedTail,
      outputBuffer: '',
    })
    return
  }

  const token = extractClaudeToken(strippedTail)
  if (!token) {
    updateConnectSession(sessionId, {
      status: 'failed',
      message:
        '"claude setup-token" exited successfully but no token could be extracted from its output. Nothing was saved — check debugTail for what it actually printed.',
      debugTail: strippedTail,
      outputBuffer: '',
    })
    return
  }

  try {
    // Browser "Connect" flow always captures a `claude setup-token` OAuth
    // token, never an API key.
    const account = await blogAiService.saveConnectedAccount({
      provider: 'anthropic',
      label: session.label,
      rawToken: token,
      authType: 'oauth',
    })
    // Redact immediately — the raw token must not remain readable on the
    // session once it's captured into the encrypted accounts table.
    updateConnectSession(sessionId, {
      status: 'success',
      account,
      outputBuffer: '[redacted after successful token capture]',
      debugTail: null,
    })
  } catch (error) {
    updateConnectSession(sessionId, {
      status: 'failed',
      message: `Token was captured but saving the account failed: ${error instanceof Error ? error.message : String(error)}`,
      outputBuffer: '[redacted after token capture attempt]',
    })
  }
}

export function submitClaudeConnectCode(sessionId: string, code: string): void {
  const session = getConnectSession(sessionId)
  if (!session) throw new Error('Connect session not found or expired')
  if (session.status !== 'awaiting_code') {
    throw new Error(`Cannot submit a code while session status is "${session.status}"`)
  }
  if (!session.ptyProcess) throw new Error('Connect session has no active process')

  const cleanCode = String(code || '').trim()
  if (!cleanCode) throw new Error('Code is required')

  // ptys conventionally expect \r (not \n) for Enter.
  session.ptyProcess.write(`${cleanCode}\r`)
  updateConnectSession(sessionId, { status: 'verifying' })

  // Safety net: if the CLI never exits after receiving the code (a hang, not
  // a clean failure), don't leave the admin staring at "Verifying code..."
  // indefinitely — fail the session so they get an actionable error instead.
  const verifyingSessionId = sessionId
  setTimeout(() => {
    const current = getConnectSession(verifyingSessionId)
    if (!current || current.status !== 'verifying') return // already resolved — nothing to do

    const debugTail = stripAnsi(current.outputBuffer).slice(-DEBUG_TAIL_CHARS)
    current.ptyProcess?.kill()
    updateConnectSession(verifyingSessionId, {
      status: 'failed',
      message: '"claude setup-token" did not respond after the code was submitted (timed out after 45s).',
      debugTail,
      outputBuffer: '',
    })
  }, VERIFY_TIMEOUT_MS).unref?.()
}

// -- Codex `login --device-auth` --------------------------------------------
//
// The non-interactive-friendly device-authorization flow: prints a URL and
// a one-time code, then polls automatically until the admin approves in
// their own browser — standard OAuth device-code grant behavior, nothing
// needs to be typed back into our UI for this one (unlike Claude).

const CODEX_URL_PATTERN = /https:\/\/[^\s]+/
// A 4-char group, a dash, and a 5-6 char group, e.g. P64A-QZ5ZM.
const CODEX_CODE_PATTERN = /\b([A-Z0-9]{4}-[A-Z0-9]{4,6})\b/

function extractCodexDeviceAuth(strippedText: string): { url: string | null; code: string | null } {
  const urlMatch = strippedText.match(CODEX_URL_PATTERN)
  const codeMatch = strippedText.match(CODEX_CODE_PATTERN)
  return {
    url: urlMatch ? urlMatch[0] : null,
    code: codeMatch ? (codeMatch[1] ?? null) : null,
  }
}

export function startCodexConnectSession(opts: { cliPath?: string | undefined } = {}): ConnectSession {
  const session = createConnectSession({ provider: 'codex' })
  let authBackup: string | null = null
  let scratchDir: string | null = null

  backupCredentialFile(CODEX_AUTH_PATH)
    .then((backup) => {
      authBackup = backup
      return spawnCodexDeviceAuth(opts.cliPath)
    })
    .then(({ ptyProcess, cwd }) => {
      scratchDir = cwd

      if (!getConnectSession(session.id)) {
        ptyProcess.kill()
        void cleanupScratchDir(cwd)
        void restoreCredentialFile(CODEX_AUTH_PATH, authBackup)
        return
      }

      updateConnectSession(session.id, { ptyProcess, scratchDir: cwd })

      ptyProcess.onData((chunk) => {
        const current = getConnectSession(session.id)
        if (!current) return

        const outputBuffer = current.outputBuffer + chunk
        const patch: Record<string, unknown> = { outputBuffer }

        if (!current.url || !current.code) {
          const { url, code } = extractCodexDeviceAuth(stripAnsi(outputBuffer))
          if (url) patch['url'] = url
          if (code) patch['code'] = code
        }
        if (current.status === 'starting' && (patch['url'] ?? current.url) && (patch['code'] ?? current.code)) {
          patch['status'] = 'awaiting_approval'
        }

        updateConnectSession(session.id, patch)
      })

      ptyProcess.onExit(({ exitCode }) => {
        const current = getConnectSession(session.id)
        // Same reasoning as the Claude flow above — a cancelled attempt
        // killing the pty was found (in the source repo's own testing) to
        // have already cleared ~/.codex/auth.json before the kill.
        if (exitCode === 0) {
          void discardCredentialBackup(authBackup)
        } else {
          void restoreCredentialFile(CODEX_AUTH_PATH, authBackup)
        }
        if (current) {
          if (exitCode === 0) {
            updateConnectSession(session.id, { status: 'success', outputBuffer: '' })
          } else {
            updateConnectSession(session.id, {
              status: 'failed',
              message: `"codex login --device-auth" exited with code ${exitCode}`,
              debugTail: stripAnsi(current.outputBuffer).slice(-DEBUG_TAIL_CHARS),
              outputBuffer: '',
            })
          }
        }
        void cleanupScratchDir(scratchDir)
      })
    })
    .catch((error: unknown) => {
      void restoreCredentialFile(CODEX_AUTH_PATH, authBackup)
      updateConnectSession(session.id, {
        status: 'failed',
        message: `Could not start "codex login --device-auth": ${error instanceof Error ? error.message : String(error)}`,
      })
    })

  return session
}
