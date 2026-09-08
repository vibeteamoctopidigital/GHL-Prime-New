import { randomUUID } from 'node:crypto'
import type { IPty } from 'node-pty'

/**
 * In-memory store for short-lived "connect from this browser" pty sessions
 * (the Claude `setup-token` login flow and the Codex `login --device-auth`
 * flow — see blogAi.cliConnect.ts). Deliberately NOT persisted to Postgres:
 * these are single-process, single-admin-tab, minutes-long flows, so a
 * server restart mid-flow just means the admin clicks the connect button
 * again — an acceptable tradeoff for not needing a table + cleanup job for
 * something this transient.
 *
 * status: 'starting' | 'awaiting_code' | 'awaiting_approval' | 'verifying'
 *         | 'success' | 'failed'
 * (Claude uses starting -> awaiting_code -> verifying -> success/failed;
 * Codex uses starting -> awaiting_approval -> success/failed.)
 */
export type ConnectSessionStatus = 'starting' | 'awaiting_code' | 'awaiting_approval' | 'verifying' | 'success' | 'failed'

export interface ConnectSession {
  id: string
  provider: 'claude' | 'codex'
  label: string
  ptyProcess: IPty | null
  scratchDir: string | null
  status: ConnectSessionStatus
  url: string | null
  code: string | null
  message: string | null
  account: Record<string, unknown> | null
  debugTail: string | null
  outputBuffer: string
  createdAt: Date
  timeoutHandle: NodeJS.Timeout | null
}

export type ConnectSessionPatch = Partial<Omit<ConnectSession, 'id' | 'createdAt' | 'timeoutHandle'>>

const SESSIONS = new Map<string, ConnectSession>()
const SESSION_TTL_MS = 10 * 60 * 1000 // 10 minutes of inactivity
const MAX_OUTPUT_BUFFER_CHARS = 200_000 // defensive cap against a runaway spinner

function killPty(session: ConnectSession): void {
  if (!session.ptyProcess) return
  try {
    session.ptyProcess.kill()
  } catch {
    // already exited — nothing to do
  }
}

/** Auto-expires (kills the pty + drops the map entry) after SESSION_TTL_MS of inactivity. Resets on every get/update. */
function scheduleExpiry(session: ConnectSession): void {
  if (session.timeoutHandle) clearTimeout(session.timeoutHandle)
  session.timeoutHandle = setTimeout(() => destroyConnectSession(session.id), SESSION_TTL_MS)
  session.timeoutHandle.unref?.()
}

export function createConnectSession(opts: { provider: 'claude' | 'codex'; label?: string }): ConnectSession {
  const session: ConnectSession = {
    id: randomUUID(),
    provider: opts.provider,
    label: opts.label || '',
    ptyProcess: null,
    scratchDir: null,
    status: 'starting',
    url: null,
    code: null,
    message: null,
    account: null,
    debugTail: null,
    outputBuffer: '',
    createdAt: new Date(),
    timeoutHandle: null,
  }
  SESSIONS.set(session.id, session)
  scheduleExpiry(session)
  return session
}

export function getConnectSession(sessionId: string): ConnectSession | null {
  const session = SESSIONS.get(sessionId)
  if (session) scheduleExpiry(session)
  return session || null
}

/** Merges `patch` onto the session in place and touches the expiry clock. Caps outputBuffer growth defensively. */
export function updateConnectSession(sessionId: string, patch: ConnectSessionPatch): ConnectSession | null {
  const session = SESSIONS.get(sessionId)
  if (!session) return null

  Object.assign(session, patch)
  if (session.outputBuffer.length > MAX_OUTPUT_BUFFER_CHARS) {
    session.outputBuffer = session.outputBuffer.slice(-MAX_OUTPUT_BUFFER_CHARS)
  }

  scheduleExpiry(session)
  return session
}

export function destroyConnectSession(sessionId: string): void {
  const session = SESSIONS.get(sessionId)
  if (!session) return
  if (session.timeoutHandle) clearTimeout(session.timeoutHandle)
  killPty(session)
  SESSIONS.delete(sessionId)
}

/** Shape safe to return from an API response — never includes ptyProcess or the raw outputBuffer. */
export function publicConnectSession(session: ConnectSession | null): Record<string, unknown> | null {
  if (!session) return null
  return {
    status: session.status,
    url: session.url,
    code: session.code,
    message: session.message,
    account: session.account,
    debugTail: session.debugTail,
  }
}
