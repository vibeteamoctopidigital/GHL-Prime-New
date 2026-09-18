/**
 * Blog Writer watcher — the one long-running process in this whole feature.
 * Everything else (the API routes, the frontend) only ever reads state or
 * inserts a 'pending' row; this script is the only code path allowed to move
 * a BlogWriteRequest through running -> waiting/completed/failed, and the
 * only thing that ever spawns `claude`.
 *
 *   npm run blog:watch
 *
 * Meant to run forever under systemd (Restart=always). See
 * docs/BLOG_WRITER.md for the unit file and the VPS login checklist this
 * depends on — this script assumes `claude` is already logged into a
 * subscription as whichever OS user runs it.
 *
 * CLI flags verified directly against `claude --help` on the version
 * installed in this repo (2.1.266) — `--allowedTools`, `--permission-mode`,
 * and `--permission-prompts` all exist exactly as used below, and a real
 * `claude -p "Reply with exactly: OK"` smoke test returned "OK" / exit 0
 * from this machine, already logged into a Pro subscription. NOT yet
 * verified: a full write-blog.md run start to finish (needs a working
 * DATABASE_URL first) and detectUsageLimit()'s regex, which is written from
 * the general shape a usage-limit message takes, not a captured real one —
 * worth logging one real hit's raw text and refining the pattern against it.
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import prisma, { disconnectDatabase } from '../src/config/prisma.js'
import env, { ROOT_DIR } from '../src/config/env.js'
import logger from '../src/shared/utils/logger.js'
import type { BlogWriterSettings } from '@prisma/client'

const HEARTBEAT_INTERVAL_MS = 15_000
const POLL_INTERVAL_MS = 20_000
/** 15 -> 30 -> 60min, then holds at 60 for any further automatic retry. */
const BACKOFF_MINUTES = [15, 30, 60]
const SIX_HOURS_MS = 6 * 60 * 60 * 1000
const HOST_TAG = `${os.hostname()}:${process.pid}`

let stopping = false
let currentChild: ChildProcessWithoutNullStreams | null = null

function shutdown(signal: string): void {
  logger.info(`Blog Writer watcher: ${signal} received, finishing up`)
  stopping = true
  // The DB row a killed session leaves 'running' gets parked 'waiting' by
  // recoverOrphanedRuns() on the NEXT start — this kill just stops the OS
  // process itself from becoming an orphan under the old PID.
  currentChild?.kill('SIGTERM')
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

// ---------------------------------------------------------------------------
// claude binary resolution
// ---------------------------------------------------------------------------

/**
 * CLAUDE_BIN (an explicit admin override) wins outright. Otherwise this
 * project's own bundled copy — @anthropic-ai/claude-code is a real
 * dependency here (see package.json) specifically so this backend runs as
 * one persistent service with no separate install step. Falling back from
 * there to ~/.local/bin (where `claude setup-token` puts a self-install on a
 * bare VPS) and finally a bare command name, which lets normal PATH lookup
 * at spawn time have the last word.
 */
function resolveClaudeBin(): string {
  if (env.CLAUDE_BIN) return env.CLAUDE_BIN

  // On Windows, node_modules/.bin/claude.cmd is a batch wrapper around this
  // real .exe one level up. Resolving straight to the .exe lets spawn() run
  // it directly with an argv array (no shell involved), which sidesteps two
  // problems a .cmd wrapper brings: needing `shell: true` at all, and that
  // option's own documented flaw (Node's DEP0190) of concatenating array
  // args into a single command-line string instead of passing each one
  // through literally — that mangling silently ate the `-p` prompt on a
  // real run here, so the exe path isn't just a nicety.
  if (process.platform === 'win32') {
    const exe = path.join(ROOT_DIR, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
    if (existsSync(exe)) return exe
  }

  const bundled = path.join(ROOT_DIR, 'node_modules', '.bin', process.platform === 'win32' ? 'claude.cmd' : 'claude')
  if (existsSync(bundled)) return bundled

  const localBin = path.join(os.homedir(), '.local', 'bin', 'claude')
  if (existsSync(localBin)) return localBin

  return 'claude'
}

// ---------------------------------------------------------------------------
// Claim (the single-flight mechanism every safety guarantee in this feature
// rests on) and spawn
// ---------------------------------------------------------------------------

/**
 * The ONLY place any code in this app is allowed to move a request out of
 * 'pending'/'waiting'. FOR UPDATE SKIP LOCKED means a second watcher
 * instance (there should never be one running deliberately, but a botched
 * restart could briefly overlap two) finds nothing rather than double-
 * claiming the same row — Postgres itself enforces the single-flight, not
 * application logic racing against itself.
 */
async function claimNextRequest(): Promise<string | null> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM blog_write_requests
      WHERE status = 'pending'
         OR (status = 'waiting' AND retry_after IS NOT NULL AND retry_after <= now())
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `
    const row = rows[0]
    if (!row) return null

    await tx.blogWriteRequest.update({
      where: { id: row.id },
      data: { status: 'running', started_at: new Date(), claimed_by: HOST_TAG, phase: null, error: null },
    })

    return row.id
  })
}

interface RunResult {
  timedOut: boolean
  exitCode: number | null
  output: string
}

function runClaudeSession(requestId: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const bin = resolveClaudeBin()
    const prompt = `Follow .claude/commands/write-blog.md for Blog Writer request ${requestId}. Do not ask for confirmation — this is an unattended run.`

    const child = spawn(
      bin,
      [
        '-p', prompt,
        '--allowedTools', 'Bash,Read,Write,WebSearch,WebFetch',
        // Without these two, --print mode defaults to routing any permission
        // prompt to "host" — with no SDK/host attached to a bare CLI spawn,
        // that would hang forever waiting for an answer nobody can give.
        // bypassPermissions is safe specifically BECAUSE --allowedTools above
        // is the real boundary (only these 5 tools are callable at all); this
        // just stops the CLI from also asking permission for each individual
        // call within that already-restricted set. --permission-prompts none
        // is defense in depth: anything that would still prompt is denied
        // outright instead of hanging.
        '--permission-mode', 'bypassPermissions',
        '--permission-prompts', 'none',
      ],
      {
        cwd: ROOT_DIR,
        env: process.env,
        // Only the .cmd/.bat fallback in resolveClaudeBin() needs a shell to
        // run at all (spawn() can't exec a batch file directly on Windows —
        // fails immediately with "spawn EINVAL"). The normal case, the
        // resolved .exe or a POSIX binary, must NOT set this: shell:true
        // concatenates the args array into one command-line string instead
        // of passing each element through literally, which silently
        // mangled the `-p` prompt (containing spaces) on a real run here.
        shell: /\.(cmd|bat)$/i.test(bin),
      },
    )
    currentChild = child

    let output = ''
    let settled = false

    const finish = (result: RunResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      currentChild = null
      resolve(result)
    }

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish({ timedOut: true, exitCode: null, output })
    }, timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.on('exit', (code) => finish({ timedOut: false, exitCode: code, output }))
    child.on('error', (err) => finish({ timedOut: false, exitCode: -1, output: `${output}\n[spawn error] ${err.message}` }))
  })
}

// ---------------------------------------------------------------------------
// Usage-limit detection
// ---------------------------------------------------------------------------

type UsageLimitResult = { isUsageLimit: false } | { isUsageLimit: true; resetAt: Date | null }

function detectUsageLimit(output: string): UsageLimitResult {
  if (!/usage limit|rate limit|quota exceeded/i.test(output)) return { isUsageLimit: false }

  const match = /reset(?:s)?\s+(?:at|in)\s+([^\n.]+)/i.exec(output)
  if (match?.[1]) {
    const parsed = new Date(match[1].trim())
    if (!Number.isNaN(parsed.getTime())) return { isUsageLimit: true, resetAt: parsed }
  }
  return { isUsageLimit: true, resetAt: null }
}

// ---------------------------------------------------------------------------
// Outcome handling for a claimed request once the session exits
// ---------------------------------------------------------------------------

async function processClaimedRequest(requestId: string, settings: BlogWriterSettings): Promise<void> {
  const timeoutMs = settings.run_timeout_minutes * 60_000
  const result = await runClaudeSession(requestId, timeoutMs)

  const request = await prisma.blogWriteRequest.findUnique({ where: { id: requestId } })
  if (!request) return

  // The session itself called blog-queue.ts save/fail before exiting —
  // nothing left for the watcher to decide.
  if (request.status === 'completed' || request.status === 'failed') {
    logger.info(`Blog Writer: request ${requestId} done (status=${request.status})`)
    return
  }

  // Still 'running': the session crashed, hung, was killed for exceeding
  // run_timeout_minutes, or hit a usage limit mid-run without a chance to
  // report it cleanly. Every one of these is "waiting to retry" unless the
  // retry budget is spent.
  const usageLimit = detectUsageLimit(result.output)
  const nextRetryCount = request.retry_count + 1

  if (nextRetryCount > settings.max_retries) {
    await prisma.$transaction(async (tx) => {
      await tx.blogWriteRequest.update({
        where: { id: requestId },
        data: { status: 'failed', error: 'Exceeded max retries', finished_at: new Date() },
      })
      if (request.topic_id) {
        await tx.blogTopic.update({
          where: { id: request.topic_id },
          data: { status: 'skipped', skip_reason: 'Exceeded max retries' },
        })
      }
    })
    logger.error(`Blog Writer: request ${requestId} failed permanently after ${request.retry_count} retries`)
    return
  }

  const backoffMinutes = BACKOFF_MINUTES[Math.min(request.retry_count, BACKOFF_MINUTES.length - 1)]!
  const retryAfter = usageLimit.isUsageLimit && usageLimit.resetAt
    ? usageLimit.resetAt
    : new Date(Date.now() + backoffMinutes * 60_000)

  const reason = result.timedOut
    ? `Run exceeded ${settings.run_timeout_minutes} minutes`
    : usageLimit.isUsageLimit
      ? 'Claude usage limit reached'
      : 'Session ended without completing'

  await prisma.blogWriteRequest.update({
    where: { id: requestId },
    data: { status: 'waiting', retry_count: nextRetryCount, retry_after: retryAfter, error: reason },
  })

  logger.warn(`Blog Writer: request ${requestId} parked waiting (${reason}) — retry #${nextRetryCount} at ${retryAfter.toISOString()}`)
  logger.warn(`Blog Writer: raw session output for ${requestId}:\n${result.output}`)
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

async function fireSchedule(schedule: { id: string; label: string; keywords: string[]; category: string | null; research_mode: string; posts_per_run: number; next_keyword_index: number }, today: Date): Promise<void> {
  if (!schedule.keywords.length) {
    await prisma.blogRunSchedule.update({ where: { id: schedule.id }, data: { last_run_date: today, last_run_at: new Date() } })
    return
  }

  let index = schedule.next_keyword_index
  for (let i = 0; i < schedule.posts_per_run; i += 1) {
    const keyword = schedule.keywords[index % schedule.keywords.length]!
    const topic = await prisma.blogTopic.create({
      data: {
        title: keyword,
        target_keyword: keyword,
        category: schedule.category,
        source: 'schedule',
        schedule_id: schedule.id,
        research_mode: schedule.research_mode,
        status: 'queued',
      },
    })
    await prisma.blogWriteRequest.create({
      data: { topic_id: topic.id, schedule_id: schedule.id, status: 'pending' },
    })
    index += 1
  }

  await prisma.blogRunSchedule.update({
    where: { id: schedule.id },
    data: { next_keyword_index: index % schedule.keywords.length, last_run_date: today, last_run_at: new Date() },
  })

  logger.info(`Blog Writer schedule "${schedule.label}" fired: queued ${schedule.posts_per_run} topic(s)`)
}

async function fireDueSchedules(): Promise<void> {
  const schedules = await prisma.blogRunSchedule.findMany({ where: { enabled: true } })
  const now = new Date()
  const today = utcMidnight(now)

  for (const schedule of schedules) {
    if (schedule.last_run_date && utcMidnight(schedule.last_run_date).getTime() === today.getTime()) continue

    const scheduledAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), schedule.hour, schedule.minute))
    if (now < scheduledAt) continue

    const dayOk = schedule.days_of_week.length === 0 || schedule.days_of_week.includes(now.getUTCDay())
    if (!dayOk) {
      await prisma.blogRunSchedule.update({ where: { id: schedule.id }, data: { last_run_date: today } })
      continue
    }

    if (now.getTime() - scheduledAt.getTime() >= SIX_HOURS_MS) {
      logger.warn(`Blog Writer schedule "${schedule.label}" missed by more than 6h — writing today off`)
      await prisma.blogRunSchedule.update({ where: { id: schedule.id }, data: { last_run_date: today } })
      continue
    }

    await fireSchedule(schedule, today)
  }
}

// ---------------------------------------------------------------------------
// Startup recovery + main loops
// ---------------------------------------------------------------------------

/** "Watcher restarted mid-run" from the spec's table — anything left 'running' from a previous process is not currently being worked on by anyone. */
async function recoverOrphanedRuns(): Promise<void> {
  const result = await prisma.blogWriteRequest.updateMany({
    where: { status: 'running' },
    data: { status: 'waiting', retry_after: new Date() },
  })
  if (result.count > 0) {
    logger.info(`Blog Writer: parked ${result.count} orphaned "running" request(s) as waiting on startup`)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function heartbeatLoop(): Promise<void> {
  while (!stopping) {
    await prisma.blogWriterSettings
      .upsert({
        where: { id: true },
        update: { last_heartbeat_at: new Date(), last_heartbeat_host: HOST_TAG },
        create: { id: true, last_heartbeat_at: new Date(), last_heartbeat_host: HOST_TAG },
      })
      .catch((error: unknown) => logger.error('Blog Writer heartbeat write failed:', error))

    await sleep(HEARTBEAT_INTERVAL_MS)
  }
}

async function mainLoop(): Promise<void> {
  await recoverOrphanedRuns()

  while (!stopping) {
    try {
      await fireDueSchedules()

      const settings = await prisma.blogWriterSettings.upsert({ where: { id: true }, update: {}, create: { id: true } })

      // Chain through everything currently claimable without waiting a full
      // poll interval between posts — this is what makes "Write all" or a
      // schedule's posts_per_run > 1 read as one continuous batch instead of
      // one post every 20s with dead air in between.
      let claimedSomething = true
      while (claimedSomething && !stopping) {
        const requestId = await claimNextRequest()
        if (!requestId) {
          claimedSomething = false
          break
        }

        logger.info(`Blog Writer: picked up request ${requestId}`)
        await processClaimedRequest(requestId, settings)

        const fresh = await prisma.blogWriterSettings.findUnique({ where: { id: true } })
        if (fresh?.stop_requested) {
          await prisma.blogWriterSettings.update({ where: { id: true }, data: { stop_requested: false } })
          logger.info('Blog Writer: stop requested — ending this chain, resuming on the next normal poll')
          break
        }
      }
    } catch (error) {
      logger.error('Blog Writer watch loop error:', error)
    }

    await sleep(POLL_INTERVAL_MS)
  }
}

async function main(): Promise<void> {
  logger.info(`Blog Writer watcher starting (${HOST_TAG}) — claude bin: ${resolveClaudeBin()}`)
  await Promise.all([heartbeatLoop(), mainLoop()])
  logger.info('Blog Writer watcher stopped')
}

main()
  .catch((error: unknown) => {
    logger.error('Blog Writer watcher crashed:', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await disconnectDatabase()
  })
