import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import prisma from '../../config/prisma.js'
import env, { ROOT_DIR } from '../../config/env.js'
import logger from '../../shared/utils/logger.js'

/**
 * Claude CLI account management for the admin dashboard.
 *
 * The Blog Writer watcher spawns `claude -p` under whichever OS user runs it,
 * and that CLI reads its Anthropic login from the user's home directory. This
 * service lets an admin see which account that is and (re)do the login from
 * the dashboard instead of SSH-ing in — `claude setup-token` run inside a
 * node-pty pseudo-terminal, which is the only way the CLI's interactive OAuth
 * flow produces its URL + code prompt (through plain pipes it writes nothing
 * and exits; verified against 2.1.266).
 *
 * One login session at a time, process-wide. The session object is kept in
 * module scope: the API runs as one long-lived server process (the same
 * process the watcher's heartbeat model already assumes).
 */

/** The PTY session type comes from our ambient node-pty declaration. */
type PtySession = import('node-pty').IPty

interface LoginSession {
  term: PtySession
  output: string
  startedAt: Date
  /** Once the URL appears we stop appending raw ANSI output to keep the response small. */
  urlCaptured: boolean
}

let session: LoginSession | null = null
let ptyAvailable: boolean | null = null

/** Same resolution order as blog-watch.ts's resolveClaudeBin(). */
function resolveClaudeBin(): string {
  if (env.CLAUDE_BIN) return env.CLAUDE_BIN

  if (process.platform === 'win32') {
    const exe = path.join(ROOT_DIR, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
    if (existsSync(exe)) return exe
    const cmd = path.join(ROOT_DIR, 'node_modules', '.bin', 'claude.cmd')
    if (existsSync(cmd)) return cmd
  } else {
    const bundled = path.join(ROOT_DIR, 'node_modules', '.bin', 'claude')
    if (existsSync(bundled)) return bundled
  }

  const localBin = path.join(os.homedir(), '.local', 'bin', 'claude')
  if (existsSync(localBin)) return localBin

  return 'claude'
}

/**
 * node-pty is an optional native dependency (it needs a compiler toolchain on
 * Linux) — the service degrades to status/logout-only if it failed to build,
 * with a clear message instead of a 500 on the login route.
 */
type PtyModule = typeof import('node-pty')

function loadPty(): PtyModule | null {
  if (ptyAvailable !== null) return ptyAvailable ? (ptyRequire() as PtyModule) : null
  try {
    // Prove it can actually spawn a terminal, not just that the module loads —
    // the native binding can load and still fail per-spawn on some hosts.
    const pty = ptyRequire() as PtyModule
    const probe = pty.spawn(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', [], { name: 'xterm', cols: 80, rows: 20 })
    try { probe.kill() } catch { /* Windows teardown can be noisy; ignore */ }
    ptyAvailable = true
    return pty
  } catch {
    ptyAvailable = false
    return null
  }
}

let ptyRequireFn: NodeJS.Require | null = null

/** ESM-safe require — the server runs as ESM, where bare `require` is undefined. */
function ptyRequire(): unknown {
  if (!ptyRequireFn) ptyRequireFn = createRequire(import.meta.url)
  return ptyRequireFn('node-pty')
}

/** Runs a claude CLI command to completion, capturing stdout+stderr. */
function runClaudeCommand(args: string[], timeoutMs = 30_000): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const bin = resolveClaudeBin()
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.on('error', (err) => {
      resolve({ code: -1, output: `${output}\n[spawn error] ${err.message}`.trim() })
    })
    child.on('exit', (code) => resolve({ code, output }))
    setTimeout(() => {
      try { child.kill('SIGTERM') } catch { /* already gone */ }
      resolve({ code: null, output })
    }, timeoutMs)
  })
}

/** Strips ANSI escape sequences — the PTY stream is full of cursor/colour codes. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g, '')
}

/**
 * Pulls the OAuth URL out of raw (or stripped) PTY output. The CLI wraps the
 * URL in an OSC-8 hyperlink escape sequence, so the URL can be bounded by a
 * BEL (\u0007) or ST (ESC \) terminator mid-match — cut at either, plus any
 * other escape introducer, rather than greedily eating terminal noise.
 */
function extractAuthUrl(output: string): string | null {
  const match = /https:\/\/claude\.com\/[^\s"'\u0007\u001b\\]+/i.exec(stripAnsi(output))
  return match ? match[0] : null
}

function publicStatus(): {
  login_in_progress: boolean
  url: string | null
  output_tail: string | null
  started_at: string | null
} {
  if (!session) {
    return { login_in_progress: false, url: null, output_tail: null, started_at: null }
  }
  const url = extractAuthUrl(session.output)
  return {
    login_in_progress: true,
    url,
    output_tail: stripAnsi(session.output).slice(-400),
    started_at: session.startedAt.toISOString(),
  }
}

export interface ClaudeAuthStatus {
  loggedIn: boolean
  email: string | null
  subscriptionType: string | null
  authMethod: string | null
  projectsDirectory: string | null
  raw: string
  login: ReturnType<typeof publicStatus>
  claude_bin: string
  pty_available: boolean
}

export async function getStatus(): Promise<ClaudeAuthStatus> {
  const { output } = await runClaudeCommand(['auth', 'status'])

  let loggedIn = false
  let email: string | null = null
  let subscriptionType: string | null = null
  let authMethod: string | null = null
  let projectsDirectory: string | null = null

  // `claude auth status` prints JSON on 2.1.266; parse defensively in case a
  // future version changes the format — fall back to a loggedIn heuristic.
  try {
    const start = output.indexOf('{')
    const parsed = JSON.parse(output.slice(start)) as Record<string, unknown>
    loggedIn = Boolean(parsed['loggedIn'])
    email = typeof parsed['email'] === 'string' ? parsed['email'] : null
    subscriptionType = typeof parsed['subscriptionType'] === 'string' ? parsed['subscriptionType'] : null
    authMethod = typeof parsed['authMethod'] === 'string' ? parsed['authMethod'] : null
    projectsDirectory = typeof parsed['projectsDirectory'] === 'string' ? parsed['projectsDirectory'] : null
  } catch {
    loggedIn = /"loggedIn"\s*:\s*true|"loggedIn": true/.test(output) || /logged in/i.test(output)
  }

  return {
    loggedIn,
    email,
    subscriptionType,
    authMethod,
    projectsDirectory,
    raw: output,
    login: publicStatus(),
    claude_bin: resolveClaudeBin(),
    pty_available: loadPty() !== null,
  }
}

/**
 * Starts `claude setup-token` in a PTY. The CLI prints the OAuth URL and a
 * "Paste code here if prompted >" input; the admin opens the URL in any
 * browser, signs in, gets a code, and POSTs it back to submitLoginCode().
 */
export function startLogin(): { ok: true; url: string | null } | { ok: false; error: string } {
  const pty = loadPty()
  if (!pty) {
    return { ok: false, error: 'node-pty is not available on this host — run `claude setup-token` over SSH instead' }
  }
  if (session) {
    const url = extractAuthUrl(session.output)
    return { ok: true, url }
  }

  const bin = resolveClaudeBin()
  try {
    const term = pty.spawn(bin, ['setup-token'], {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: ROOT_DIR,
      env: process.env as Record<string, string>,
    })

    session = { term, output: '', startedAt: new Date(), urlCaptured: false }

    term.onData((data: string) => {
      if (!session || session.term !== term) return
      // Cap the buffer so a chatty spinner can't grow it unbounded.
      if (session.output.length < 200_000) session.output += data
    })

    term.onExit(({ exitCode }: { exitCode: number }) => {
      logger.info(`claude setup-token session exited (code=${exitCode})`)
      // A completed or cancelled login clears the session; the admin checks
      // status to see the new account. Keep the tail around via getStatus
      // raw output if the login failed — the next status call re-reads it.
      if (session?.term === term) session = null
    })

    // Give the CLI a moment to print the URL before the first poll.
    const url = null
    return { ok: true, url }
  } catch (error) {
    session = null
    const message = error instanceof Error ? error.message : String(error)
    logger.error('claude setup-token spawn failed:', message)
    return { ok: false, error: message }
  }
}

/** Feeds the OAuth code the admin pasted from the browser into the waiting PTY. */
export function submitLoginCode(code: string): { ok: boolean; error?: string } {
  if (!session) {
    return { ok: false, error: 'No login session running — start one first' }
  }
  const trimmed = code.trim()
  if (!trimmed) {
    return { ok: false, error: 'Code is empty' }
  }
  session.term.write(`${trimmed}\r`)
  return { ok: true }
}

/** Abandons the in-flight login without logging anything in or out. */
export function cancelLogin(): { ok: boolean } {
  if (!session) return { ok: true }
  try { session.term.kill() } catch { /* already gone */ }
  session = null
  return { ok: true }
}

// node-pty's Windows conpty agent can throw an unhandled "AttachConsole
// failed" while a PTY is being torn down — harmless, but fatal to the server
// as an uncaughtException. Registered once at module scope: anything whose
// message mentions AttachConsole is swallowed; every other error is re-thrown
// so real crashes still crash.
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err?.message?.includes('AttachConsole')) {
    logger.warn('node-pty teardown noise suppressed (AttachConsole)')
    return
  }
  throw err
})

/**
 * Logs out. If a login session is somehow still open it is killed first —
 * `claude auth logout` and a half-finished setup-token would fight over the
 * same credential store.
 */
export async function logout(): Promise<{ ok: boolean; output: string }> {
  cancelLogin()
  const { output } = await runClaudeCommand(['auth', 'logout'])
  return { ok: true, output }
}

/**
 * Which OS user context the CLI lives in — the same user the Blog Writer
 * watcher must run as. Surfaced on the dashboard so a "works in my terminal
 * but watcher says offline" mystery is diagnosable from the UI.
 */
export function getHostInfo(): { hostname: string; platform: string; username: string; claude_bin: string } {
  return {
    hostname: os.hostname(),
    platform: process.platform,
    username: os.userInfo().username,
    claude_bin: resolveClaudeBin(),
  }
}

/** Prisma client export keeps the module's import graph uniform with siblings. */
export { prisma }
