/**
 * The bridge between the dashboard's button and a post being written.
 *
 * The dashboard cannot generate anything: writing runs through Claude Code on
 * a subscription, which needs a machine and a logged-in CLI rather than an API
 * key. So a press is recorded as a row, and this process — running wherever
 * that CLI lives — picks it up. Schedules fire from here too, for the same
 * reason: a schedule that fires where nothing is listening produces a request
 * nobody will ever pick up.
 *
 * The heartbeat is the one thing that must never stop. Without it the
 * dashboard cannot tell "nothing queued" from "nobody listening".
 *
 *   npm run blog:watch
 *
 * Meant to run forever under systemd (Restart=always). See docs/BLOG_WRITER.md.
 * Ported from octopi's scripts/blog-writer-watch.ts, onto Prisma.
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Prisma } from '@prisma/client'
import prisma, { disconnectDatabase } from '../src/config/prisma.js'
import env, { ROOT_DIR } from '../src/config/env.js'
import {
  frontTopicOrder,
  getActiveBatch,
  listSchedules,
  prependKeywords,
  setActiveBatch,
  touchWriterHeartbeat,
} from '../src/modules/blog-writer/blogWriter.store.js'
import { discoverHeadlines, type FeedArticle } from '../src/modules/blog-writer/lib/headlines.js'
import { RunTracker, type Progress } from '../src/modules/blog-writer/lib/run-progress.js'
import { TRANSIENT_FAILURES, clampPerRun, type FailureKind } from '../src/modules/blog-writer/lib/rules.js'
import { describeSchedule, dueState, type ScheduleRow } from '../src/modules/blog-writer/lib/run-schedule.js'
import { classifyTopic } from '../src/modules/blog-writer/lib/rules.js'
import { STORY_PICKER_SYSTEM_PROMPT } from '../src/modules/blog-writer/lib/story-picker-prompt.js'

/** How often to look for work. */
const POLL_MS = 30_000

/**
 * How often to report being alive. On its own timer, far shorter than the
 * staleness window: a run takes minutes, and for all of them the loop is
 * inside processNext() and never comes back.
 */
const HEARTBEAT_MS = 15_000

/**
 * How long one post may take before it is abandoned. Research plus writing
 * plus an audit plus image fetching is minutes; the ceiling exists for a run
 * that has genuinely hung, which would otherwise hold the queue closed forever.
 */
const RUN_TIMEOUT_MS = 25 * 60 * 1000

/**
 * Exactly what the writer may do, and nothing else.
 *
 * Bash is narrowed to the named scripts the workflow needs. Scoped this way
 * the worst outcome of a confused run is a bad draft, which is reviewable,
 * rather than an action nobody authorised on a machine holding credentials.
 */
const ALLOWED_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Write',
  'Edit',
  'Bash(npm run blog:queue*)',
  'Bash(npm run blog:rules)',
  'Bash(npm run blog:audit*)',
  'Bash(npm run blog:import)',
].join(',')

/** Snapshots of deleted schedules older than this are pruned at startup (Postgres has no TTL index). */
const DELETED_SCHEDULE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/* -------------------------------------------------------------------------- */
/* claude binary resolution                                                   */
/* -------------------------------------------------------------------------- */

/**
 * CLAUDE_BIN (an explicit admin override) wins outright. Otherwise this
 * project's own bundled copy (@anthropic-ai/claude-code is a real dependency),
 * then ~/.local/bin, then PATH, then the VS Code extension's bundled binary.
 *
 * On Windows the bundled .exe is preferred over the .cmd shim: a .cmd needs
 * `shell: true`, and with a shell Node joins the arguments into one command
 * line without quoting them, which mangles the allowlist and the prompt.
 */
function findClaude(): string | null {
  if (env.CLAUDE_BIN) return env.CLAUDE_BIN

  if (process.platform === 'win32') {
    const exe = path.join(ROOT_DIR, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
    if (existsSync(exe)) return exe
  }

  const bundled = path.join(ROOT_DIR, 'node_modules', '.bin', process.platform === 'win32' ? 'claude.cmd' : 'claude')
  if (existsSync(bundled)) return bundled

  const localBin = path.join(os.homedir(), '.local', 'bin', 'claude')
  if (existsSync(localBin)) return localBin

  const onPath = process.platform === 'win32' ? 'claude.cmd' : 'claude'
  for (const dir of (process.env['PATH'] ?? '').split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, onPath)
    if (existsSync(candidate)) return candidate
  }

  const extensions = path.join(os.homedir(), '.vscode', 'extensions')
  if (!existsSync(extensions)) return null

  const extension = readdirSync(extensions)
    .filter((name) => name.startsWith('anthropic.claude-code-'))
    .sort()
    .reverse()
    .map((name) => path.join(extensions, name, 'resources', 'native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude'))
    .find((candidate) => existsSync(candidate))

  return extension ?? null
}

/* -------------------------------------------------------------------------- */
/* Startup housekeeping                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Release requests left mid-run by a watcher that stopped. Parked rather than
 * failed, and due immediately: a restart is the same kind of interruption as
 * a usage limit. Counted, so a writer that crashes every time it starts this
 * request eventually stops requeueing it.
 */
async function releaseOrphans(): Promise<void> {
  const result = await prisma.blogWriteRequest.updateMany({
    where: { status: 'running' },
    data: {
      status: 'waiting',
      retry_after: new Date(),
      detail: 'the writer restarted, picking this up again',
      error: 'The writer stopped while this was being written. It will be retried.',
      attempts: { increment: 1 },
    },
  })
  if (result.count > 0) console.log(`requeued ${result.count} request(s) left running by a previous start`)
}

async function pruneDeletedSchedules(): Promise<void> {
  const result = await prisma.blogDeletedSchedule.deleteMany({
    where: { deleted_at: { lt: new Date(Date.now() - DELETED_SCHEDULE_TTL_MS) } },
  })
  if (result.count > 0) console.log(`pruned ${result.count} deleted-schedule snapshot(s) older than a week`)
}

/** Update the heartbeat. Failing this is worth logging but never worth exiting. */
async function beat(): Promise<void> {
  try {
    await touchWriterHeartbeat()
  } catch (error) {
    console.error('heartbeat failed:', (error as Error).message)
  }
}

/* -------------------------------------------------------------------------- */
/* Running the writer                                                         */
/* -------------------------------------------------------------------------- */

/**
 * What a run cost, read off Claude Code's own closing event. Null when the
 * run died before reporting one — "we do not know" and "it cost nothing" look
 * identical as zeroes, and only one of them is ever true.
 */
type RunUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUsd: number
  turns: number
  durationMs: number
  models: string[]
}

type RunResult = { ok: boolean; output: string; slug: string; usage: RunUsage | null }

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Pull the cost out of a `result` event. Nothing in here may throw. */
function readUsage(event: Record<string, unknown>): RunUsage {
  const usage = (event['usage'] ?? {}) as Record<string, unknown>
  const models = event['modelUsage']
  return {
    inputTokens: num(usage['input_tokens']),
    outputTokens: num(usage['output_tokens']),
    cacheReadTokens: num(usage['cache_read_input_tokens']),
    cacheCreationTokens: num(usage['cache_creation_input_tokens']),
    costUsd: num(event['total_cost_usd']),
    turns: num(event['num_turns']),
    durationMs: num(event['duration_ms']),
    models: models && typeof models === 'object' ? Object.keys(models) : [],
  }
}

/** Run the writing workflow once, non-interactively. */
function runWriter(claude: string, prompt: string, onProgress: (progress: Progress) => void): Promise<RunResult> {
  return new Promise((resolve) => {
    // No shell unless the resolved binary needs one — see findClaude.
    const needsShell = /\.(cmd|bat)$/i.test(claude)

    const child = spawn(
      claude,
      [
        '-p',
        prompt,
        '--allowed-tools',
        ALLOWED_TOOLS,
        // Writing to a spec this tight is not work the largest model is needed
        // for, and the run is long: research pages are re-sent every turn.
        '--model',
        env.BLOG_WRITER_MODEL || 'sonnet',
        // The allowlist above is the real boundary. In --print mode anything
        // that would still prompt has nobody to ask, so it is denied outright
        // rather than hanging.
        '--permission-mode',
        'manual',
        '--permission-prompts',
        'none',
        // The run reports itself step by step, which is what lets the
        // dashboard show a post being written rather than a spinner.
        '--output-format',
        'stream-json',
        '--verbose',
      ],
      {
        cwd: ROOT_DIR,
        shell: needsShell,
        // stdin closed rather than inherited: nothing is going to type at this.
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      },
    )

    const tracker = new RunTracker(onProgress)
    let finalMessage = ''
    let errorText = ''
    let usage: RunUsage | null = null

    // Events arrive as newline-delimited JSON, and a chunk boundary can fall
    // anywhere. Anything before the last newline is complete.
    let buffered = ''
    child.stdout.on('data', (chunk: Buffer) => {
      buffered += chunk.toString()
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue

        let event: Record<string, unknown>
        try {
          event = JSON.parse(trimmed) as Record<string, unknown>
        } catch {
          continue
        }

        if (event['type'] === 'result') {
          finalMessage = typeof event['result'] === 'string' ? event['result'] : ''
          usage = readUsage(event)
          const denials = event['permission_denials']
          if (Array.isArray(denials) && denials.length > 0) {
            // The likeliest cause of a run that produced nothing.
            errorText += `\nBlocked by the tool allowlist: ${denials
              .map((denial) => (denial as { tool_name?: string })?.tool_name ?? '?')
              .join(', ')}`
          }
          continue
        }

        try {
          tracker.ingest(event)
        } catch (error) {
          console.error('could not read a run event:', (error as Error).message)
        }
      }
    })

    child.stderr.on('data', (chunk: Buffer) => {
      errorText += chunk.toString()
      if (errorText.length > 20_000) errorText = errorText.slice(-20_000)
    })

    /** What an editor should read if the run failed, rather than raw JSON. */
    const report = (): string =>
      [tracker.transcript.slice(-25).join('\n'), finalMessage, errorText].filter(Boolean).join('\n\n').trim()

    const timer = setTimeout(() => {
      child.kill()
      resolve({
        ok: false,
        output: `${report()}\n\nTimed out after ${RUN_TIMEOUT_MS / 60000} minutes.`,
        slug: tracker.slug,
        usage,
      })
    }, RUN_TIMEOUT_MS)

    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, output: `${report()}\n\nCould not start Claude Code: ${error.message}`, slug: tracker.slug, usage })
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, output: report(), slug: tracker.slug, usage })
    })
  })
}

/* -------------------------------------------------------------------------- */
/* Why a run stopped                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The subscription's usage window closing, in the several shapes it is said.
 * Deliberately broad: a false match costs one wasted retry twenty minutes
 * later, a missed match costs an editor seeing "failed" on something fine.
 */
const LIMIT_PATTERNS = [
  /usage limit/i,
  /rate.?limit/i,
  /\b429\b/,
  /limit reached/i,
  /quota (?:exceeded|reached)/i,
  /too many requests/i,
  /upgrade to (?:pro|max)/i,
  /resets? at/i,
]

/** Nothing worth writing was found. A real answer, and not one time fixes. */
const NOTHING_PATTERNS = [
  /nothing (?:worth writing|to write)/i,
  /no (?:usable |citable )?sources/i,
  /unwritable/i,
  /not enough sources/i,
  /could not find (?:enough|any)/i,
]

/** Order matters: a run that hit the usage limit often also times out waiting on it. */
function classifyFailure(output: string): FailureKind {
  const text = output || ''
  if (LIMIT_PATTERNS.some((re) => re.test(text))) return 'limit'
  if (NOTHING_PATTERNS.some((re) => re.test(text))) return 'nothing-to-write'
  if (/timed out after/i.test(text)) return 'timeout'
  return 'error'
}

/**
 * The moment the limit lifts, read out of the message that reported it.
 * Handles a full timestamp, or a clock time meaning the next time the clock
 * reads it. Null when nothing usable is found — the caller falls back to backoff.
 */
function resetAtFrom(output: string): Date | null {
  const text = output || ''
  const now = Date.now()

  const isoMatch = text.match(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?/)
  if (isoMatch) {
    const at = new Date(isoMatch[0].replace(' ', 'T'))
    if (!Number.isNaN(at.getTime()) && at.getTime() > now) return at
  }

  const clock = text.match(/reset[a-z]*\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i)
  if (clock) {
    const hour12 = Number(clock[1])
    const minute = Number(clock[2] ?? 0)
    const suffix = clock[3]?.toLowerCase()

    if (hour12 <= 23 && minute <= 59) {
      let hour = hour12
      if (suffix === 'pm' && hour12 < 12) hour += 12
      if (suffix === 'am' && hour12 === 12) hour = 0

      const at = new Date(now)
      at.setSeconds(0, 0)
      at.setHours(hour, minute)
      if (at.getTime() <= now) at.setDate(at.getDate() + 1)
      return at
    }
  }

  return null
}

/** Nothing is worth waiting longer than this for without a person looking at it. */
const MAX_WAIT_MS = 7 * 24 * 60 * 60 * 1000

/** 15 -> 30 -> 60 minutes, then holds at 60. */
function backoffMs(attempts: number): number {
  const minutes = Math.min(15 * 2 ** Math.max(0, attempts - 1), 60)
  return minutes * 60 * 1000
}

/**
 * How long to hold this request before trying again. A stated reset time
 * wins outright; two minutes are added because a limit that lifts "at 3pm"
 * tends to lift a moment after.
 */
function waitMsFor(output: string, attempts: number): number {
  const resetAt = resetAtFrom(output)
  if (resetAt) {
    const until = resetAt.getTime() - Date.now() + 2 * 60 * 1000
    if (until > 0) return Math.min(until, MAX_WAIT_MS)
  }
  return backoffMs(attempts)
}

/** Automatic retries before a transient stop is treated as a real failure. */
const MAX_AUTO_RETRIES = 6

/**
 * Finished runs a batch may use beyond its announced total before it is ended
 * on that count alone. The topic count is what normally ends a batch; this
 * only stops one whose failures leave no topic behind to mark from going
 * round forever. See continueBatch.
 */
const BATCH_ATTEMPT_SLACK = 3

function describeWait(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

function usageJson(usage: RunUsage | null): Prisma.InputJsonValue | undefined {
  return usage ? (usage as unknown as Prisma.InputJsonValue) : undefined
}

/* -------------------------------------------------------------------------- */
/* Batches                                                                    */
/* -------------------------------------------------------------------------- */

/** Batches a schedule started carry its id in theirs; a button press's do not. */
function isScheduleBatch(batchId: string): boolean {
  return batchId.startsWith('schedule-')
}

/**
 * Put a schedule's unwritten keywords back where they came from — the FRONT
 * of its list, so tomorrow's run takes them first — and out of the queue in
 * the same breath. A no-op for a manual batch.
 */
async function returnUnwritten(batchId: string): Promise<void> {
  const leftover = await prisma.blogTopic.findMany({
    where: { batch_id: batchId, status: 'queued', schedule_id: { not: null } },
    orderBy: { order: 'asc' },
  })
  if (leftover.length === 0) return

  const scheduleId = leftover[0]!.schedule_id!
  await prisma.$transaction(async (tx) => {
    await prependKeywords(
      scheduleId,
      leftover.map((row) => ({
        topic: row.topic,
        notes: row.notes,
        imageCount: row.image_count,
        words: row.words,
        ctaVariant: row.cta_variant,
      })),
      tx,
    )
    await tx.blogTopic.deleteMany({ where: { id: { in: leftover.map((row) => row.id) } } })
  })

  console.log(`  batch ${batchId}: returned ${leftover.length} unwritten keyword(s) to the front of the schedule`)
}

/** Clear the batch switch and say why it stopped. */
async function endBatch(batchId: string, why: string): Promise<void> {
  await setActiveBatch('')
  await returnUnwritten(batchId)
  console.log(`  batch ${batchId} finished: ${why}`)
}

/** The next of a scheduled batch's own rows, or null when it has none left. */
async function nextOwnTopic(batchId: string): Promise<{ id: string } | null> {
  const row = await prisma.blogTopic.findFirst({
    where: { batch_id: batchId, status: 'queued' },
    orderBy: { order: 'asc' },
    select: { id: true },
  })
  return row ? { id: row.id } : null
}

/**
 * Queue the next post in a batch, if the batch is still running.
 *
 * Three things stop the chain, and none of them interrupt a post being
 * written: the queue running dry, somebody pressing Stop, and the batch
 * producing as many posts as it said it would.
 */
async function continueBatch(batchId: string, batchTotal: number, postsPerRun: number): Promise<void> {
  if (!batchId) return

  if ((await getActiveBatch()) !== batchId) {
    console.log(`  batch ${batchId} was stopped; not queueing another`)
    await returnUnwritten(batchId)
    return
  }

  // A scheduled batch counts only its own rows; a manual one counts the queue.
  const scheduled = isScheduleBatch(batchId)
  const remaining = scheduled
    ? await prisma.blogTopic.count({ where: { batch_id: batchId, status: 'queued' } })
    : await prisma.blogTopic.count({ where: { status: 'queued' } })
  if (remaining === 0) {
    await endBatch(batchId, scheduled ? 'all of its keywords are written' : 'the queue is empty')
    return
  }

  if (batchTotal > 0) {
    /*
     * Two counters, and either one reaching its cap ends the batch. Topics
     * are the honest measure of what was produced; requests are the measure
     * that cannot stall. The request cap sits ABOVE the total: every run
     * settles its topic as done or skipped, so the topic count normally
     * decides, and the request count only guards against a topic that can no
     * longer be found to skip.
     */
    const [written, attempts] = await Promise.all([
      prisma.blogTopic.count({ where: { batch_id: batchId, status: { in: ['done', 'skipped'] } } }),
      prisma.blogWriteRequest.count({ where: { batch_id: batchId, status: { in: ['done', 'failed'] } } }),
    ])

    if (written >= batchTotal || attempts >= batchTotal + BATCH_ATTEMPT_SLACK) {
      await endBatch(batchId, `${written} of ${batchTotal} written`)
      return
    }
  }

  // Named for a scheduled batch, so the run writes this row and no other.
  const next = scheduled ? await nextOwnTopic(batchId) : null

  await prisma.blogWriteRequest.create({
    data: {
      requested_by: `batch:${batchId}`,
      batch_id: batchId,
      batch_total: batchTotal,
      topic_id: next?.id ?? null,
      // Carried from the run that just finished rather than left unset, so a
      // chain announced for one post does not silently take the default.
      posts_per_run: postsPerRun,
    },
  })

  console.log(`  batch ${batchId}: queued the next post, ${remaining} topic(s) left`)
}

/* -------------------------------------------------------------------------- */
/* Schedules                                                                  */
/* -------------------------------------------------------------------------- */

async function markDayRun(id: string, day: string): Promise<void> {
  await prisma.blogRunSchedule.update({ where: { id }, data: { last_run_day: day } })
}

/**
 * Move this schedule's next keywords into the live queue, owned by the batch
 * from the moment they exist. A keyword carrying its own settings keeps them;
 * the schedule's are stamped on the rest.
 */
async function queueFromKeywords(schedule: ScheduleRow, wanted: number, batchId: string): Promise<number> {
  const taking = await prisma.blogScheduleKeyword.findMany({
    where: { schedule_id: schedule.id },
    orderBy: { position: 'asc' },
    take: wanted,
  })
  if (taking.length === 0) return 0

  const last = await prisma.blogTopic.findFirst({ orderBy: { order: 'desc' }, select: { order: true } })
  let order = last?.order ?? 0

  await prisma.$transaction(async (tx) => {
    for (const keyword of taking) {
      await tx.blogTopic.create({
        data: {
          topic: keyword.topic,
          kind: classifyTopic(keyword.topic),
          notes: keyword.notes,
          order: (order += 10),
          image_count: keyword.image_count ?? schedule.imageCount,
          words: keyword.words ?? schedule.words,
          cta_variant: keyword.cta_variant || schedule.ctaVariant,
          schedule_id: schedule.id,
          schedule_name: schedule.name,
          batch_id: batchId,
        },
      })
      console.log(`[${new Date().toISOString()}] queued "${keyword.topic}"`)
    }
    // Dropped from the backlog by id: the first N are the ones just used.
    await tx.blogScheduleKeyword.deleteMany({ where: { id: { in: taking.map((keyword) => keyword.id) } } })
  })

  return taking.length
}

/**
 * Headlines the ranker is shown in one call. Eighty with summaries is a few
 * thousand tokens — one cheap call.
 */
const RANK_PAGE = 80

/**
 * Headlines one site may contribute to the pool. Capped per site so every
 * site is heard from before any site is heard from twice — a wire service
 * publishing every ten minutes must not fill the pool alone.
 */
const MAX_PER_SITE = 12

/** The pool's ceiling across every site: three pages covers twenty-five sites at the per-site cap. */
const MAX_HEADLINES = RANK_PAGE * 3

/** How long the ranking call may take. One turn, no tools; a minute is generous. */
const RANK_TIMEOUT_MS = 90_000

/**
 * Ask Claude Code which of today's headlines are worth a post. One call, one
 * turn, no tools, on the smallest model — through the CLI rather than an API,
 * because there is no API key. Returns fewer than asked for, including none,
 * whenever that is the honest answer.
 */
function rankHeadlines(
  claude: string,
  articles: (FeedArticle & { site: string })[],
  count: number,
  brief: string,
  alreadyChosen: string[] = [],
): Promise<{ n: number; angle: string }[]> {
  const list = articles
    .map((article, i) =>
      article.summary ? `${i + 1}. [${article.site}] ${article.title}\n   ${article.summary}` : `${i + 1}. [${article.site}] ${article.title}`,
    )
    .join('\n')

  const briefBlock = brief.trim()
    ? `\n\n--- THE EDITOR'S STANDING BRIEF ---\n${brief.trim().slice(0, 1000)}\nLet this steer which stories you choose where it concerns subject matter. Ignore it where it only describes tone or format.`
    : ''

  const chosenBlock = alreadyChosen.length
    ? `\n\n--- ALREADY CHOSEN TODAY (from an earlier page of headlines) ---\n${alreadyChosen.map((title) => `- ${title}`).join('\n')}\nDo not choose a story about any of these events again, however it is headlined.`
    : ''

  const prompt = `${STORY_PICKER_SYSTEM_PROMPT}\n\nToday's stories from the sites we watch:\n\n${list}${briefBlock}${chosenBlock}\n\nChoose AT MOST ${count} worth writing about, best first, and no two about the same event. Return {"picks": [{"n": <number>, "angle": "..."}]}.\n\nReturn fewer, or none at all, if that is the honest answer. The "angle" is at most 200 characters.`

  return new Promise((resolve) => {
    const needsShell = /\.(cmd|bat)$/i.test(claude)
    const child = spawn(
      claude,
      ['-p', '--model', 'haiku', '--max-turns', '1', '--allowed-tools', '', '--permission-mode', 'manual', '--permission-prompts', 'none', '--output-format', 'json'],
      { cwd: ROOT_DIR, shell: needsShell, stdio: ['pipe', 'pipe', 'pipe'], env: process.env },
    )

    let out = ''
    let err = ''
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()))

    const timer = setTimeout(() => {
      child.kill()
      console.error('  ranking headlines timed out')
      resolve([])
    }, RANK_TIMEOUT_MS)

    const done = (picks: { n: number; angle: string }[]) => {
      clearTimeout(timer)
      resolve(picks)
    }

    child.on('error', (error) => {
      console.error('  could not start Claude Code to rank headlines:', error.message)
      done([])
    })

    child.on('close', (code) => {
      if (code !== 0) {
        console.error(`  ranking headlines failed (exit ${code}): ${err.slice(-300).trim()}`)
        return done([])
      }
      try {
        const envelope = JSON.parse(out) as { result?: string }
        const text = typeof envelope.result === 'string' ? envelope.result : out
        const body = text.match(/\{[\s\S]*\}/)?.[0] ?? ''
        const parsed = JSON.parse(body) as { picks?: { n?: unknown; angle?: unknown }[] }
        const picks = (parsed.picks ?? [])
          .map((pick) => ({
            n: typeof pick.n === 'number' ? pick.n : Number(pick.n),
            angle: typeof pick.angle === 'string' ? pick.angle.slice(0, 200) : '',
          }))
          .filter((pick) => Number.isInteger(pick.n) && pick.n >= 1 && pick.n <= articles.length)
        done(picks)
      } catch {
        console.error('  ranking headlines returned something that was not JSON')
        done([])
      }
    })

    // The prompt goes over stdin: eighty headlines is past what a command line carries.
    child.stdin.end(prompt)
  })
}

/**
 * Scan every site on the schedule, pick the day's best stories, queue them
 * at the FRONT of the queue (a story is worth less every hour; a keyword is
 * not). Reading is HTTP and free; judging is a small model call per page.
 */
async function queueFromHeadlines(schedule: ScheduleRow, wanted: number, batchId: string, claude: string): Promise<number> {
  const sites = schedule.sites.filter((site) => site.enabled)
  if (sites.length === 0) return 0

  type Candidate = FeedArticle & { site: string; siteNotes: string }

  // Read every site, and keep the tally per site from the start: the tally is
  // what the dashboard shows against each site after the run.
  const scanAt = new Date()
  const tally = new Map<string, { found: number; shown: number; picked: number; via: string; error: string }>()
  const bySite = new Map<string, Candidate[]>()

  for (const site of sites) {
    const result = await discoverHeadlines(site.url)
    console.log(
      `[${new Date().toISOString()}] ${site.url}: ${result.articles.length} headline(s) via ${result.via}${result.error ? ` — ${result.error}` : ''}`,
    )
    tally.set(site.url, { found: result.articles.length, shown: 0, picked: 0, via: result.via, error: result.error ?? '' })
    bySite.set(
      site.url,
      result.articles.map((article) => ({ ...article, site: site.url, siteNotes: site.notes })),
    )
  }

  // Never a story already in the queue or already written.
  const urls = [...new Set([...bySite.values()].flat().map((article) => article.url))]
  const known = new Set(
    urls.length ? (await prisma.blogTopic.findMany({ where: { topic: { in: urls } }, select: { topic: true } })).map((row) => row.topic) : [],
  )

  // Fair share: each site's own list newest first, capped, then dealt round
  // the sites a headline at a time. Undated (scraped) stories keep page order
  // rather than being sorted to the bottom.
  const seen = new Set<string>()
  const perSite: Candidate[][] = []
  for (const site of sites) {
    const fresh = (bySite.get(site.url) ?? []).filter((article) => {
      if (known.has(article.url) || seen.has(article.url)) return false
      seen.add(article.url)
      return true
    })
    const dated = fresh.filter((article) => article.publishedAt)
    const undated = fresh.filter((article) => !article.publishedAt)
    dated.sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0))
    perSite.push([...dated, ...undated].slice(0, MAX_PER_SITE))
  }

  const candidates: Candidate[] = []
  for (let round = 0; candidates.length < MAX_HEADLINES; round += 1) {
    let dealt = false
    for (const list of perSite) {
      const article = list[round]
      if (!article) continue
      candidates.push(article)
      dealt = true
      if (candidates.length >= MAX_HEADLINES) break
    }
    if (!dealt) break
  }

  const sitesWithScan = (usedSites: Set<string>) =>
    schedule.sites.map((site) => {
      const counts = tally.get(site.url)
      return {
        ...site,
        ...(usedSites.has(site.url) ? { lastUsedAt: scanAt.toISOString() } : {}),
        ...(counts ? { lastScan: { at: scanAt.toISOString(), ...counts } } : {}),
      }
    }) as unknown as Prisma.InputJsonValue

  const recordScan = async (usedSites: Set<string>) => {
    await prisma.blogRunSchedule.update({ where: { id: schedule.id }, data: { sites: sitesWithScan(usedSites) } })
  }

  if (candidates.length === 0) {
    await recordScan(new Set())
    return 0
  }

  // Every site's own note, pooled, is the brief.
  const brief = sites
    .filter((site) => site.notes.trim())
    .map((site) => `${site.url}: ${site.notes.trim()}`)
    .join('\n')

  // A page at a time until the day's count is met or the pool runs out, with
  // the picks so far named so the next page cannot choose the same event.
  const picked: { article: Candidate; angle: string }[] = []
  let shown = 0
  while (picked.length < wanted && shown < candidates.length) {
    const page = candidates.slice(shown, shown + RANK_PAGE)
    for (const article of page) {
      const counts = tally.get(article.site)
      if (counts) counts.shown += 1
    }

    const picks = await rankHeadlines(claude, page, wanted - picked.length, brief, picked.map((pick) => pick.article.title))
    console.log(
      `[${new Date().toISOString()}] "${schedule.name}": page ${Math.floor(shown / RANK_PAGE) + 1}, ${page.length} headline(s) shown, ${picks.length} picked`,
    )

    for (const pick of picks) {
      if (picked.length >= wanted) break
      const article = page[pick.n - 1]
      if (!article || picked.some((chosen) => chosen.article.url === article.url)) continue
      picked.push({ article, angle: pick.angle })
      const counts = tally.get(article.site)
      if (counts) counts.picked += 1
    }

    shown += page.length
  }

  console.log(
    `[${new Date().toISOString()}] "${schedule.name}": ${candidates.length} headline(s) from ${sites.length} site(s), ${shown} shown, ${picked.length} picked`,
  )

  if (picked.length === 0) {
    await recordScan(new Set())
    return 0
  }

  let order = await frontTopicOrder(picked.length)
  const usedSites = new Set<string>()

  for (const { article, angle } of picked) {
    usedSites.add(article.site)
    await prisma.blogTopic.create({
      data: {
        topic: article.url,
        kind: 'link',
        // The angle is the business question the post answers; the site's
        // note is what the editor wanted from that publication.
        notes: [angle, article.siteNotes].filter(Boolean).join(' | '),
        order: (order += 10),
        image_count: schedule.imageCount,
        words: schedule.words,
        cta_variant: schedule.ctaVariant,
        schedule_id: schedule.id,
        schedule_name: schedule.name,
        batch_id: batchId,
      },
    })
    console.log(`[${new Date().toISOString()}] queued "${article.title}" from ${article.site}`)
  }

  await recordScan(usedSites)

  return picked.length
}

/**
 * Start this schedule's daily run: a batch of one-post runs over the day's
 * topics, whichever mode supplied them. Returns how many posts the day will
 * write, or 0 if there is nothing to do.
 */
async function startQueueBatch(schedule: ScheduleRow, claude: string): Promise<number> {
  // Never start on top of a batch that is already running.
  const active = await getActiveBatch()
  if (active) {
    console.log(`[${new Date().toISOString()}] "${schedule.name}" is due but batch ${active} is still working the queue`)
    return 0
  }

  // Minted before the move so the rows can carry it from the moment they exist.
  const batchId = `schedule-${schedule.id}-${Date.now()}`

  const total =
    schedule.mode === 'queue'
      ? await queueFromKeywords(schedule, schedule.postsPerDay, batchId)
      : await queueFromHeadlines(schedule, schedule.postsPerDay, batchId, claude)
  if (total === 0) return 0

  await setActiveBatch(batchId)

  const first = await nextOwnTopic(batchId)

  await prisma.blogWriteRequest.create({
    data: {
      requested_by: `schedule:${schedule.name}`,
      batch_id: batchId,
      batch_total: total,
      topic_id: first?.id ?? null,
      // One post per link, so the chain's length is the day's count exactly.
      posts_per_run: 1,
    },
  })

  return total
}

/**
 * Act on any alarm that is due. At most one acts per pass: two alarms set to
 * the same minute would otherwise both fire and the second would be dropped.
 */
async function maybeSchedule(claude: string): Promise<void> {
  const schedules = await listSchedules()
  if (schedules.length === 0) return

  // A run already in flight is today's run for whichever alarm queued it.
  const inFlight = await prisma.blogWriteRequest.findFirst({ where: { status: { in: ['pending', 'running', 'waiting'] } } })
  if (inFlight) return

  for (const schedule of schedules) {
    const state = dueState(schedule, schedule.lastRunDay)
    if (state.action === 'wait') continue

    if (state.action === 'skip') {
      console.log(`[${new Date().toISOString()}] "${schedule.name}" skipped: ${state.reason}`)
      await markDayRun(schedule.id, state.day)
      continue
    }

    const total = await startQueueBatch(schedule, claude)
    if (total === 0) {
      // Day left unmarked on purpose: keywords added at nine, or a site that
      // publishes its story at ten, should still get this morning's run.
      console.log(
        `[${new Date().toISOString()}] "${schedule.name}" is due but has nothing to write${
          schedule.mode === 'queue' ? ' (no keywords left)' : ' (no story worth a post today)'
        }`,
      )
      continue
    }

    await markDayRun(schedule.id, state.day)
    console.log(`[${new Date().toISOString()}] "${schedule.name}" started a batch of ${total} — ${describeSchedule(schedule)}`)
    return
  }
}

/* -------------------------------------------------------------------------- */
/* One request, start to finish                                               */
/* -------------------------------------------------------------------------- */

/**
 * Claim the oldest claimable request — pending, or waiting and now due —
 * with a conditional update inside a transaction, so two watchers cannot
 * both take it. Returns null when there is nothing to do.
 */
async function claimNext(): Promise<{ id: string } | null> {
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
    await tx.blogWriteRequest.update({ where: { id: row.id }, data: { status: 'running', started_at: new Date() } })
    return { id: row.id }
  })
}

async function processNext(claude: string): Promise<void> {
  const claimedId = await claimNext()
  if (!claimedId) return

  const claimed = await prisma.blogWriteRequest.findUniqueOrThrow({ where: { id: claimedId.id } })

  /*
   * Record what this run is for, in words, before it can go wrong — and its
   * id, so a failure can name and skip the right row. `explicitTopicId` is
   * whether the DASHBOARD named a topic, captured before the resolution
   * below fills one in for a plain press.
   */
  const explicitTopicId = claimed.topic_id
  let topicId = claimed.topic_id
  let topicLabel = claimed.topic_label

  if (!topicLabel) {
    const forTopic = explicitTopicId
      ? await prisma.blogTopic.findUnique({ where: { id: explicitTopicId }, select: { id: true, topic: true } })
      : await prisma.blogTopic.findFirst({ where: { status: 'queued' }, orderBy: { order: 'asc' }, select: { id: true, topic: true } })

    if (forTopic?.topic) {
      topicLabel = forTopic.topic
      topicId = forTopic.id
      await prisma.blogWriteRequest.update({ where: { id: claimed.id }, data: { topic_label: forTopic.topic, topic_id: forTopic.id } })
    }
  }

  console.log(`[${new Date().toISOString()}] picked up request ${claimed.id}${topicLabel ? ` — ${topicLabel}` : ''}`)

  // A specific topic if the dashboard named one (sent as an id, never as
  // text somebody typed), otherwise whatever is next.
  const prompt = explicitTopicId
    ? `/write-blog id:${explicitTopicId}`
    : claimed.posts_per_run
      ? `/write-blog ${clampPerRun(claimed.posts_per_run)}`
      : '/write-blog'

  // Progress is written as it happens, but only when it changes. A phase
  // change always gets a row in the history; a detail change on the same
  // phase is throttled.
  let lastPhase = ''
  let lastDetailAt = 0
  const steps: { phase: string; detail: string; at: string }[] = Array.isArray(claimed.steps)
    ? (claimed.steps as { phase: string; detail: string; at: string }[])
    : []

  const onProgress = ({ phase, detail }: Progress) => {
    const changedPhase = phase !== lastPhase
    if (!changedPhase && Date.now() - lastDetailAt < 5_000) return

    lastPhase = phase
    lastDetailAt = Date.now()

    if (changedPhase) steps.push({ phase, detail, at: new Date().toISOString() })

    // Never awaited: the run must not pause for the dashboard.
    void prisma.blogWriteRequest
      .update({ where: { id: claimed.id }, data: { phase, detail, ...(changedPhase ? { steps } : {}) } })
      .catch(() => {})

    console.log(`  ${phase}${detail ? ` — ${detail}` : ''}`)
  }

  const { ok, output, slug, usage } = await runWriter(claude, prompt, onProgress)

  if (usage) {
    console.log(
      `  cost: $${usage.costUsd.toFixed(4)} · ${usage.turns} turns · ${usage.inputTokens + usage.cacheCreationTokens} in / ${usage.outputTokens} out / ${usage.cacheReadTokens} cached`,
    )
  }

  /*
   * A clean exit is not a post. The session can end with exit 0 and nothing
   * saved. A post is proved by the slug the importer printed, or failing that
   * by the topic itself having been closed since the run began (the tracker
   * misses the slug when the session chains the import onto another command).
   */
  let savedSlug = slug
  let saved = ok && Boolean(slug)
  if (ok && !saved) {
    const closed = await prisma.blogTopic.findFirst({
      where: {
        status: 'done',
        written_at: { gte: claimed.started_at ?? new Date(0) },
        ...(explicitTopicId ? { id: explicitTopicId } : {}),
      },
      select: { blog_slug: true },
    })
    if (closed) {
      saved = true
      savedSlug = closed.blog_slug
    }
  }

  if (saved) {
    steps.push({ phase: 'done', detail: 'finished', at: new Date().toISOString() })
    await prisma.blogWriteRequest.update({
      where: { id: claimed.id },
      data: {
        status: 'done',
        finished_at: new Date(),
        phase: 'done',
        detail: savedSlug ? `saved ${savedSlug}` : 'finished',
        blog_slug: savedSlug,
        error: '',
        failure_kind: null,
        retry_after: null,
        steps,
        usage: usageJson(usage),
      },
    })
    // Stamp the batch on whatever this run finished, so the summary can say
    // which posts belong to this pass through the queue.
    if (claimed.batch_id) {
      await prisma.blogTopic.updateMany({
        where: { status: 'done', batch_id: '', written_at: { gte: claimed.started_at ?? new Date(0) } },
        data: { batch_id: claimed.batch_id },
      })
    }

    console.log(`[${new Date().toISOString()}] request ${claimed.id} done`)
    await continueBatch(claimed.batch_id, claimed.batch_total, claimed.posts_per_run)
    return
  }

  // A clean exit with no post is its own kind unless the transcript names a
  // better one: "nothing worth writing" said politely is still that, and a
  // usage-limit message with exit 0 still deserves the retry.
  const classified = classifyFailure(output)
  const kind: FailureKind = ok && classified === 'error' ? 'no-post' : classified
  const attempts = claimed.attempts + 1
  const willRetry = TRANSIENT_FAILURES.includes(kind) && attempts <= MAX_AUTO_RETRIES
  // The tail: the useful part of a failed run is how it ended.
  const error = output.slice(-1500).trim()

  if (willRetry) {
    const wait = waitMsFor(output, attempts)
    const retryAfter = new Date(Date.now() + wait)
    const when = describeWait(wait)

    steps.push({ phase: 'starting', detail: `waiting: ${kind}`, at: new Date().toISOString() })
    await prisma.blogWriteRequest.update({
      where: { id: claimed.id },
      data: {
        status: 'waiting',
        phase: 'starting',
        detail: kind === 'limit' ? `usage limit reached, retrying in ${when}` : `timed out, retrying in ${when}`,
        failure_kind: kind,
        attempts,
        retry_after: retryAfter,
        error,
        steps,
        usage: usageJson(usage),
      },
    })

    console.log(
      `[${new Date().toISOString()}] request ${claimed.id} hit ${kind}; retry ${attempts}/${MAX_AUTO_RETRIES} in ${when} (${retryAfter.toISOString()})`,
    )
    return
  }

  steps.push({ phase: 'done', detail: 'failed', at: new Date().toISOString() })
  await prisma.blogWriteRequest.update({
    where: { id: claimed.id },
    data: {
      status: 'failed',
      finished_at: new Date(),
      phase: 'done',
      detail:
        kind === 'nothing-to-write'
          ? 'nothing worth writing was found'
          : kind === 'no-post'
            ? 'finished without saving a post'
            : attempts > MAX_AUTO_RETRIES
              ? `gave up after ${MAX_AUTO_RETRIES} automatic retries`
              : 'the run failed',
      failure_kind: kind,
      attempts,
      retry_after: null,
      error,
      steps,
      usage: usageJson(usage),
    },
  })

  /*
   * Move the topic aside so the queue keeps going. Since the next run always
   * takes the lowest-ordered queued row, leaving it in place means it is
   * picked again immediately and everything behind it is never reached.
   * Skipped rather than deleted, with the reason on the row; Retry puts it back.
   */
  const stuck = explicitTopicId
    ? await prisma.blogTopic.findFirst({ where: { id: explicitTopicId, status: 'queued' }, select: { id: true, topic: true } })
    : await prisma.blogTopic.findFirst({ where: { status: 'queued' }, orderBy: { order: 'asc' }, select: { id: true, topic: true } })

  if (stuck) {
    const reason =
      kind === 'nothing-to-write'
        ? 'Nothing worth writing was found for this topic.'
        : kind === 'no-post'
          ? 'The run finished without saving a post.'
          : attempts > MAX_AUTO_RETRIES
            ? `Gave up after ${MAX_AUTO_RETRIES} automatic retries.`
            : 'The run broke on this topic.'

    await prisma.blogTopic.updateMany({
      where: { id: stuck.id, status: 'queued' },
      data: { status: 'skipped', skip_reason: reason, batch_id: claimed.batch_id },
    })
    await prisma.blogWriteRequest.update({ where: { id: claimed.id }, data: { topic_id: stuck.id, topic_label: stuck.topic } })
    console.log(`  queue: skipped "${stuck.topic}" — ${reason}`)
  }

  console.log(`[${new Date().toISOString()}] request ${claimed.id} FAILED (${kind})`)
  console.error(output.slice(-1500))
  console.log(`  topic: ${topicId ?? '(none)'}`)

  // A skipped topic still shortens the queue, so the batch moves on.
  await continueBatch(claimed.batch_id, claimed.batch_total, claimed.posts_per_run)
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const claude = findClaude()
  if (!claude) {
    console.error('Claude Code CLI not found. Run `npm install` (it is a dependency), or set CLAUDE_BIN.')
    process.exit(1)
  }

  console.log('blog writer watching')
  console.log(`  claude:   ${claude}`)
  console.log(`  model:    ${env.BLOG_WRITER_MODEL || 'sonnet'}`)
  console.log(`  polling every ${POLL_MS / 1000}s. Ctrl-C to stop.`)

  const schedules = await listSchedules()
  if (schedules.length === 0) {
    console.log('  schedules: none set up')
  } else {
    console.log('  schedules:')
    for (const schedule of schedules) console.log(`    ${schedule.name} — ${describeSchedule(schedule)}`)
  }
  console.log('')

  await releaseOrphans()
  await pruneDeletedSchedules()

  await beat()
  const heartbeat = setInterval(() => void beat(), HEARTBEAT_MS)

  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    clearInterval(heartbeat)
    console.log('\nstopping; the dashboard will show the writer offline shortly.')
    await disconnectDatabase().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', () => void stop())
  process.on('SIGTERM', () => void stop())

  // Sequential rather than on an interval: one post at a time, and a run that
  // takes twenty minutes must not have twenty polls stacked up behind it.
  while (!stopping) {
    try {
      await maybeSchedule(claude)
      await processNext(claude)
    } catch (error) {
      console.error('poll failed:', (error as Error).message)
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
