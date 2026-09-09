import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import env from '../../config/env.js'
import logger from '../../shared/utils/logger.js'
import type { IPty } from 'node-pty'

/**
 * node-pty process mechanics for the two "connect from this browser" login
 * flows (`claude setup-token`, `codex login --device-auth`). Deliberately
 * split out from blogAi.cliRunner.ts: everything there uses plain
 * child_process pipes because those calls run in non-interactive print mode
 * (`-p` / `exec`). These two commands are full interactive TUIs (raw
 * ANSI cursor-control + a spinner) that genuinely need a real
 * pseudo-terminal to behave correctly — plain stdio pipes are not
 * sufficient here.
 *
 * node-pty is a native addon — it needs to have compiled successfully at
 * `npm install` time (build tools on a VPS) AND its compiled binary needs to
 * actually load in whatever runtime executes it. On a serverless platform
 * (Vercel) that second part can fail even when the first succeeded, since
 * the build machine and the Lambda runtime aren't guaranteed identical. It's
 * therefore loaded lazily, on first actual use, instead of at module import
 * time: a broken/incompatible binary then only fails the two connect-start
 * calls below (surfaced to the admin as a clear error, with "paste a token"
 * still available as the other, pty-free connect path) instead of throwing
 * at import time and taking down every route that transitively imports this
 * file — which, before this fix, meant the whole API.
 */

const CLAUDE_BIN = env.CLAUDE_CLI_PATH || '/usr/bin/claude'
const CODEX_BIN = env.CODEX_CLI_PATH || '/usr/bin/codex'

type PtyModule = typeof import('node-pty')
let ptyModule: PtyModule | null | undefined // undefined = not yet attempted

async function loadPty(): Promise<PtyModule> {
  if (ptyModule === undefined) {
    try {
      ptyModule = await import('node-pty')
    } catch (error) {
      ptyModule = null
      logger.error('node-pty could not be loaded — "Connect in browser" is unavailable in this environment:', error instanceof Error ? error.message : error)
    }
  }

  if (!ptyModule) throw new Error('Interactive connect is not available in this environment. Use "Paste a token" instead.')
  return ptyModule
}

async function makeScratchDir(prefix: string): Promise<string> {
  const dir = path.join(os.tmpdir(), `${prefix}-${randomUUID()}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

export interface PtySpawnResult {
  ptyProcess: IPty
  cwd: string
}

/**
 * Spawns `command` under a pty with cwd set to a fresh empty scratch
 * directory. `cols` is deliberately huge: `claude setup-token` prints a
 * ~300-350 char OAuth URL on one line, and a normal terminal width wraps it
 * mid-query-string, silently truncating before redirect_uri/code_challenge/
 * state — breaking the URL extraction in blogAi.cliConnect.ts. A wide pty
 * avoids the wrap at the source instead of trying to rejoin wrapped lines
 * after the fact.
 */
async function spawnInScratchDir(
  command: string,
  args: string[],
  prefix: string,
  extraEnvFromCwd: (cwd: string) => Record<string, string> = () => ({}),
): Promise<PtySpawnResult> {
  const pty = await loadPty()
  const cwd = await makeScratchDir(prefix)

  // Windows can't CreateProcess a .cmd/.bat file directly — which is exactly
  // what an npm global install produces (e.g. claude.cmd) — it always
  // fails with "Cannot create process, error code: 2". A normal terminal
  // hides this by routing through cmd.exe; node-pty has no built-in `shell`
  // option to do that for us, so it's done explicitly here. Unix binaries
  // are real executables and run directly, no shell needed.
  const [file, fileArgs] = process.platform === 'win32' ? ['cmd.exe', ['/d', '/s', '/c', command, ...args]] : [command, args]

  const ptyProcess = pty.spawn(file as string, fileArgs, {
    name: 'xterm-color',
    cols: 2000,
    rows: 30,
    cwd,
    env: { ...process.env, ...extraEnvFromCwd(cwd) } as Record<string, string>,
  })

  return { ptyProcess, cwd }
}

/**
 * CLAUDE_CONFIG_DIR (set to this run's own disposable scratch dir) points
 * `claude setup-token` at an isolated config directory instead of the real
 * ~/.claude — Claude Code documents this as relocating ALL of its
 * home-directory state, including ~/.claude.json (which holds the OAuth
 * session) and ~/.claude/.credentials.json. Without it, `claude setup-token`
 * operates against — and can silently log out — whatever personal Claude
 * Code session (e.g. a VS Code extension) already exists on the same
 * machine. This matters here specifically: we only ever need the OAuth
 * token this command PRINTS, which we capture as text and store ourselves —
 * nothing depends on Claude Code's own on-disk session state surviving, so
 * full isolation is strictly better than backup/restore. The scratch dir is
 * deleted after the connect flow finishes either way (cleanupScratchDir),
 * so nothing here needs to persist.
 */
export function spawnClaudeSetupToken(cliPath?: string): Promise<PtySpawnResult> {
  return spawnInScratchDir(cliPath || CLAUDE_BIN, ['setup-token'], 'blog-ai-claude-connect', (cwd) => ({ CLAUDE_CONFIG_DIR: cwd }))
}

export function spawnCodexDeviceAuth(cliPath?: string): Promise<PtySpawnResult> {
  return spawnInScratchDir(cliPath || CODEX_BIN, ['login', '--device-auth'], 'blog-ai-codex-connect')
}

export async function cleanupScratchDir(dir: string | null | undefined): Promise<void> {
  if (!dir) return
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
}

// -- Ambient-credential backup/restore --------------------------------------
//
// Starting `codex login --device-auth` deletes the existing
// ~/.codex/auth.json almost immediately, even if the attempt is then
// cancelled or fails before a human ever gets to approve it in their
// browser — a cancelled/failed connect attempt can permanently log out a
// previously-working ambient Codex session. To make connect attempts safe
// to cancel, back up the relevant credential file before spawning either
// login command, and restore it if the process doesn't exit 0 (covers both
// a genuine failure and a kill() from the admin cancelling mid-flow, since
// killing a pty triggers the same onExit handler with a non-zero code).
// Applied symmetrically to Claude's credential file too, since the cost of
// backing up a small JSON file is negligible next to the cost of silently
// repeating this mistake.

export const CLAUDE_CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json')
export const CODEX_AUTH_PATH = path.join(os.homedir(), '.codex', 'auth.json')

/** Copies `filePath` to a sibling temp file and returns that backup path, or null if there was nothing to back up. */
export async function backupCredentialFile(filePath: string): Promise<string | null> {
  const backupPath = `${filePath}.autoblog-connect-backup-${randomUUID()}`
  try {
    await fs.copyFile(filePath, backupPath)
    return backupPath
  } catch {
    return null
  }
}

/** Restores a previously-taken backup over `filePath` and removes the backup file. No-op if `backupPath` is null. */
export async function restoreCredentialFile(filePath: string, backupPath: string | null): Promise<void> {
  if (!backupPath) return
  await fs.copyFile(backupPath, filePath).catch(() => undefined)
  await fs.rm(backupPath, { force: true }).catch(() => undefined)
}

/** Discards a backup without restoring it (the connect attempt succeeded, so the new credential file is the intended state). */
export async function discardCredentialBackup(backupPath: string | null): Promise<void> {
  if (!backupPath) return
  await fs.rm(backupPath, { force: true }).catch(() => undefined)
}
