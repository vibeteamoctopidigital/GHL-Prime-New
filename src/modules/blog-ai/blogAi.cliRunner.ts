import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import env from '../../config/env.js'

/**
 * Raw subprocess mechanics for shelling out to the `claude` and `codex`
 * CLIs — this is how generation is billed against a flat-rate subscription
 * instead of metered per-token API usage. No database access here — pure
 * process I/O, mirroring blogAi.providers.ts's shape so the engine/checker/
 * research modules can call either transport interchangeably.
 *
 * CLI flag choices below match the source repo's verified-live invocation
 * shape (Claude Code CLI, Codex CLI). If the installed CLI version changes
 * its flags, this is the one place to update.
 *
 * `@anthropic-ai/claude-code` / `@openai/codex` are real project
 * dependencies (see package.json) specifically so this runs as a single
 * persistent service — e.g. Railway — with nothing else to deploy;
 * env.ts's CLAUDE_CLI_PATH/CODEX_CLI_PATH point at the binaries `npm
 * install` puts in this project's own node_modules/.bin by default.
 */

const GENERATION_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes — a full blog post generation
const RESEARCH_TIMEOUT_MS = 2 * 60 * 1000 // research runs its own web searches, give it more room than a quick ping
const TEST_TIMEOUT_MS = 30 * 1000 // 30 seconds — the "Test connection" buttons
const KILL_GRACE_MS = 5000

export interface TestResult {
  ok: boolean
  message: string
}

function resolveClaudeBin(cliPath?: string | null): string {
  return cliPath || env.CLAUDE_CLI_PATH
}

function resolveCodexBin(cliPath?: string | null): string {
  return cliPath || env.CODEX_CLI_PATH
}

interface SubprocessResult {
  code: number | null
  stdout: string
  stderr: string
}

/**
 * Spawns `command` with `args` and enforces a hard timeout: SIGTERM first,
 * then SIGKILL if the process hasn't exited `killGraceMs` later. Deliberately
 * not using child_process.exec's built-in timeout — that only ever sends
 * SIGTERM, which a hung/misbehaving CLI can ignore and never actually exit.
 *
 * `opts.stdin`, when provided, is written to the child's stdin and the pipe
 * is closed — this is how a large prompt reaches Claude without ever going
 * on the command line (see invokeClaudeCli() below for why that matters on
 * Windows). Omit it for calls with no large payload; stdin is then closed
 * immediately instead of left open, since `codex exec` peeks at stdin for
 * extra appended instructions even when a prompt is given as an argument,
 * and would otherwise hang until the hard timeout killed it.
 */
function runSubprocess(command: string, args: string[], opts: { env: NodeJS.ProcessEnv; timeoutMs: number; stdin?: string }): Promise<SubprocessResult> {
  return new Promise((resolve, reject) => {
    let proc: ReturnType<typeof spawn>
    try {
      // shell on Windows only: an npm-installed CLI there is a .cmd shim,
      // which plain spawn() can't execute directly (fails with "Cannot
      // create process, error code: 2" — the same CreateProcess limitation
      // worked around in blogAi.ptyRunner.ts). Node does its own best-effort
      // argument quoting for cmd.exe in this mode; unusual shell-special
      // characters in a prompt are a known edge case there. Not needed on
      // Unix, where the CLI is a real executable.
      proc = spawn(command, args, {
        env: opts.env,
        windowsHide: true,
        stdio: [opts.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      })
    } catch (error) {
      reject(error as Error)
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    let hardKillTimer: NodeJS.Timeout | null = null

    const softTimer = setTimeout(() => {
      proc.kill('SIGTERM')
      hardKillTimer = setTimeout(() => proc.kill('SIGKILL'), KILL_GRACE_MS)
    }, opts.timeoutMs)

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    proc.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(softTimer)
      if (hardKillTimer) clearTimeout(hardKillTimer)
      reject(error)
    })

    proc.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(softTimer)
      if (hardKillTimer) clearTimeout(hardKillTimer)
      resolve({ code, stdout, stderr })
    })

    if (opts.stdin !== undefined) {
      proc.stdin?.end(opts.stdin, 'utf8')
    }
  })
}

// -- Claude Code CLI ----------------------------------------------------------

/**
 * A stable, persistent config directory for every test/run CLI call — as
 * opposed to blogAi.ptyRunner.ts's spawnClaudeSetupToken(), which isolates
 * the CONNECT flow in a disposable scratch dir that gets deleted once that
 * flow finishes. Without this, buildClaudeEnv() left CLAUDE_CONFIG_DIR unset
 * entirely, so every later call fell back to the server's real ~/.claude —
 * a different, unrelated directory from the one the token was captured
 * under. The token itself is a self-contained env-var credential, but
 * Claude Code's CLI process still reads/writes local config-dir state on
 * every invocation, and running that against a directory with no relation
 * to the connect flow is a plausible source of "OAuth access token is
 * invalid" on Test/Run even though Connect itself succeeded. This directory
 * persists across calls and server restarts (never cleaned up), unlike the
 * connect flow's scratch dirs — it needs to still be there next time.
 */
const CLAUDE_TEST_RUN_CONFIG_DIR = path.join(os.homedir(), '.claude-blog-ai-runtime')
try {
  mkdirSync(CLAUDE_TEST_RUN_CONFIG_DIR, { recursive: true })
} catch {
  // Best-effort — if this directory can't be created, the CLI call itself
  // will surface a clear filesystem error rather than failing silently here.
}

/**
 * authType 'oauth' (default) uses the admin's Claude Code subscription login
 * via CLAUDE_CODE_OAUTH_TOKEN — billed against the flat-rate subscription.
 * authType 'api_key' is the opt-in advanced path for admins who want a plain
 * Anthropic API key instead — metered, but useful as a fallback if no
 * subscription is connected. Only ONE of the two credential env vars is
 * ever set so the unused one can never shadow the intended credential.
 */
function buildClaudeEnv(token: string, authType: 'oauth' | 'api_key'): NodeJS.ProcessEnv {
  const childEnv = { ...process.env }
  if (authType === 'api_key') {
    childEnv['ANTHROPIC_API_KEY'] = token
    delete childEnv['CLAUDE_CODE_OAUTH_TOKEN']
  } else {
    childEnv['CLAUDE_CODE_OAUTH_TOKEN'] = token
    delete childEnv['ANTHROPIC_API_KEY']
  }
  childEnv['CLAUDE_CONFIG_DIR'] = CLAUDE_TEST_RUN_CONFIG_DIR
  return childEnv
}

// Placeholder -p instruction used whenever the real prompt goes over stdin
// instead — Claude Code documents piping data in via stdin alongside a short
// -p instruction (e.g. `git diff | claude -p "review this"`); this tells it
// the piped content IS the complete task, not supplementary data to review.
const STDIN_PROMPT_INSTRUCTION =
  'Read the complete task instructions provided via stdin below and follow them exactly. Respond only as they specify — nothing else.'

// The built-in Claude Code system prompt primes the model to check its
// cross-session memory notes (auto-memory) and reach for tools as a first
// move, regardless of `--tools ''`. With tools actually disabled, there is
// no matching `tool_use` schema entry left for it to call, so instead of
// silently skipping that step it narrates a fake one as plain text (e.g.
// "Let me check memory... **Tool: bash** Parameters: ..."), which lands
// directly in stdout ahead of the real answer and breaks JSON.parse() on
// the write step. `--system-prompt` fully replaces the built-in prompt
// (confirmed via `claude --help`: the per-machine "memory paths" section is
// specific to the default prompt and is dropped once a custom one is given),
// which removes this behavior at the source rather than trying to filter
// its output after the fact. Kept generic enough to also apply to the
// research call, which keeps its tools ON for web search — this only stops
// it narrating tools it does NOT have, it doesn't block ones it does.
const CLI_SYSTEM_PROMPT =
  'You are completing a single one-shot automated task with no user present to respond to. Do not check memory or any prior session notes, and do not narrate or attempt to use a tool unless it is one you have actually been granted for this task. Respond with only the output the task instructions below ask for — no preamble, no commentary about your own process.'

/**
 * Runs `claude ... --tools ""` non-interactively for the actual blog-post
 * write step — tools OFF for clean structured output. Throws on non-zero exit.
 *
 * Both the prompt AND the JSON schema go over stdin, not as command-line
 * argument values. Two independent reasons converge on the same fix:
 *  1. A full blog-writing prompt is several KB, and on Windows every call
 *     here is routed through `cmd.exe` (see runSubprocess() above, needed
 *     for the .cmd shim) — cmd.exe caps a command line at roughly 8191
 *     characters and fails with "The command line is too long" well before
 *     a real prompt fits.
 *  2. `--json-schema` has no file-input form (verified against the CLI
 *     reference — inline JSON is the only option), and a JSON string's heavy
 *     quote/brace usage reliably corrupts under cmd.exe's argument quoting,
 *     surfacing as a JSON parse error that isn't actually about invalid
 *     JSON — it's the string arriving mangled.
 * Piping via stdin is a documented, supported Claude Code CLI mechanism
 * (capped at 10MB), not a workaround bolted on the side. The tradeoff:
 * without --json-schema, the CLI no longer enforces the shape itself — we
 * fall back to the same prompted-schema + zod-validation pattern already
 * used for the OpenAI and research paths (see blogAi.engine.ts's
 * parseAiResponse()), which already has to handle a malformed reply anyway.
 */
export interface ClaudeWriteOpts {
  prompt: string
  jsonSchema: Record<string, unknown>
  token: string
  authType: 'oauth' | 'api_key'
  model?: string | undefined
  cliPath?: string | undefined
}

export async function invokeClaudeCli(opts: ClaudeWriteOpts): Promise<string> {
  const args = ['-p', STDIN_PROMPT_INSTRUCTION, '--output-format', 'text', '--tools', '', '--no-session-persistence', '--system-prompt', CLI_SYSTEM_PROMPT]
  if (opts.model) args.push('--model', opts.model)

  const stdinPayload = [
    opts.prompt,
    '',
    'Your entire response must be a single JSON object — no markdown fences, no extra text before or after it —',
    'matching exactly this JSON Schema:',
    JSON.stringify(opts.jsonSchema),
  ].join('\n')

  const { code, stdout, stderr } = await runSubprocess(resolveClaudeBin(opts.cliPath), args, {
    env: buildClaudeEnv(opts.token, opts.authType),
    timeoutMs: GENERATION_TIMEOUT_MS,
    stdin: stdinPayload,
  })

  if (code !== 0) {
    throw new Error(`claude CLI exited with code ${code}: ${(stderr || stdout || '(no output)').slice(0, 1000)}`)
  }
  return stdout
}

/**
 * The topic-research call — tools left ON (no `--tools ''`) so Claude Code's
 * own default tool access (including web search) is available. No
 * `--json-schema`: the output is free text ending in a JSON blob, parsed
 * defensively by blogAi.research.ts, same as the direct-API path.
 */
export interface ClaudeResearchOpts {
  prompt: string
  token: string
  authType: 'oauth' | 'api_key'
  model?: string | undefined
  cliPath?: string | undefined
}

export async function researchWithClaudeCli(opts: ClaudeResearchOpts): Promise<string> {
  const args = ['-p', STDIN_PROMPT_INSTRUCTION, '--output-format', 'text', '--no-session-persistence', '--system-prompt', CLI_SYSTEM_PROMPT]
  if (opts.model) args.push('--model', opts.model)

  const { code, stdout, stderr } = await runSubprocess(resolveClaudeBin(opts.cliPath), args, {
    env: buildClaudeEnv(opts.token, opts.authType),
    timeoutMs: RESEARCH_TIMEOUT_MS,
    stdin: opts.prompt,
  })

  if (code !== 0) {
    throw new Error(`claude CLI exited with code ${code}: ${(stderr || stdout || '(no output)').slice(0, 1000)}`)
  }
  return stdout
}

export interface ClaudeTestOpts {
  token: string
  authType: 'oauth' | 'api_key'
  model?: string | undefined
  cliPath?: string | undefined
}

/** Trivial ping used by the "Test" button on a Claude account row. */
export async function testClaudeCliAccount(opts: ClaudeTestOpts): Promise<TestResult> {
  const args = ['-p', 'Reply with the single word OK.', '--output-format', 'text', '--tools', '', '--no-session-persistence', '--system-prompt', CLI_SYSTEM_PROMPT]
  if (opts.model) args.push('--model', opts.model)

  try {
    const { code, stdout, stderr } = await runSubprocess(resolveClaudeBin(opts.cliPath), args, {
      env: buildClaudeEnv(opts.token, opts.authType),
      timeoutMs: TEST_TIMEOUT_MS,
    })

    if (code === 0 && stdout.trim()) return { ok: true, message: stdout.trim().slice(0, 200) }
    return { ok: false, message: (stderr || stdout || `claude CLI exited with code ${code}`).trim().slice(0, 500) }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

// -- Codex CLI (ambient login, no per-account token) -------------------------

async function withScratchDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = path.join(os.tmpdir(), `blog-ai-${randomUUID()}`)
  await fs.mkdir(dir, { recursive: true })
  try {
    return await fn(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * Runs `codex exec` in a fresh empty scratch directory and reads back
 * `-o/--output-last-message`'s file for the clean final-message text.
 * Deliberately does NOT set/override CODEX_HOME — Codex has no per-call
 * credential; it uses whatever ambient `codex login --device-auth` session
 * is already active on the box (default ~/.codex), so the child process
 * just inherits the parent env as-is.
 */
async function runCodexExec(prompt: string, opts: { schema?: Record<string, unknown>; model?: string | undefined; timeoutMs: number; cliPath?: string | undefined }): Promise<string> {
  return withScratchDir(async (dir) => {
    const outputFile = path.join(dir, 'output.txt')
    const args = ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ignore-user-config', '-C', dir]

    if (opts.schema) {
      const schemaFile = path.join(dir, 'schema.json')
      await fs.writeFile(schemaFile, JSON.stringify(opts.schema), 'utf8')
      args.push('--output-schema', schemaFile)
    }
    if (opts.model) args.push('-m', opts.model)
    args.push('-o', outputFile, prompt)

    const { code, stdout, stderr } = await runSubprocess(resolveCodexBin(opts.cliPath), args, { env: process.env, timeoutMs: opts.timeoutMs })

    if (code !== 0) {
      throw new Error(`codex CLI exited with code ${code}: ${(stderr || stdout || '(no output)').slice(0, 1000)}`)
    }

    let output: string
    try {
      output = await fs.readFile(outputFile, 'utf8')
    } catch {
      throw new Error('codex CLI exited successfully but did not write an output-last-message file')
    }

    if (!output.trim()) throw new Error('codex CLI produced an empty response')
    return output
  })
}

export interface CodexWriteOpts {
  prompt: string
  jsonSchema: Record<string, unknown>
  model?: string | undefined
  cliPath?: string | undefined
}

export function invokeCodexCli(opts: CodexWriteOpts): Promise<string> {
  return runCodexExec(opts.prompt, { schema: opts.jsonSchema, model: opts.model, timeoutMs: GENERATION_TIMEOUT_MS, cliPath: opts.cliPath })
}

export interface CodexResearchOpts {
  prompt: string
  model?: string | undefined
  cliPath?: string | undefined
}

export function researchWithCodexCli(opts: CodexResearchOpts): Promise<string> {
  return runCodexExec(opts.prompt, { model: opts.model, timeoutMs: RESEARCH_TIMEOUT_MS, cliPath: opts.cliPath })
}

export interface CodexTestOpts {
  model?: string | undefined
  cliPath?: string | undefined
}

/** Reports whether the ambient login-level `codex login --device-auth` session is still valid. */
export async function testCodexConnection(opts: CodexTestOpts = {}): Promise<TestResult> {
  try {
    const output = await runCodexExec('Reply with the single word OK.', { model: opts.model, timeoutMs: TEST_TIMEOUT_MS, cliPath: opts.cliPath })
    return { ok: true, message: output.trim().slice(0, 200) }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** Plain (non-pty) status check — `codex login status`, e.g. "Logged in using ChatGPT". */
export async function codexLoginStatus(cliPath?: string): Promise<{ loggedIn: boolean; raw: string }> {
  try {
    const { code, stdout, stderr } = await runSubprocess(resolveCodexBin(cliPath), ['login', 'status'], { env: process.env, timeoutMs: TEST_TIMEOUT_MS })
    const raw = (stdout || stderr || '').trim()
    return { loggedIn: code === 0 && /logged in/i.test(raw), raw: raw.slice(0, 1000) }
  } catch (error) {
    return { loggedIn: false, raw: error instanceof Error ? error.message : String(error) }
  }
}

/** Plain (non-pty) `codex logout` — disconnects the single ambient device-auth session. */
export async function codexLogout(cliPath?: string): Promise<{ ok: boolean; message: string }> {
  try {
    const { code, stdout, stderr } = await runSubprocess(resolveCodexBin(cliPath), ['logout'], { env: process.env, timeoutMs: TEST_TIMEOUT_MS })
    if (code === 0) return { ok: true, message: (stdout || 'Logged out.').trim().slice(0, 200) }
    return { ok: false, message: (stderr || stdout || `codex logout exited with code ${code}`).trim().slice(0, 500) }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
