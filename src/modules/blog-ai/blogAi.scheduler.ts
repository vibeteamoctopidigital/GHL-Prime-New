import cron from 'node-cron'
import prisma from '../../config/prisma.js'
import logger from '../../shared/utils/logger.js'
import blogAiService from './blogAi.service.js'
import { runBlogAiEngine } from './blogAi.engine.js'
import { sweepExpiredDrafts } from './blogAi.checker.js'

/**
 * Auto Blog's "is a post due right now" logic — deliberately STATELESS and
 * safe to call as often as you like. Two very different processes call the
 * exact same function below:
 *   - A persistent Node process (`npm start` on a VPS) can hold an in-process
 *     `node-cron` poller (armSchedulerPoller(), called once from
 *     server.ts's bootstrap()).
 *   - A serverless deployment (Vercel) has no persistent process to hold a
 *     timer at all — `POST /blog-ai/cron/trigger` (blogAi.controller.ts,
 *     protected by a shared secret, meant to be pinged by an external
 *     service like cron-job.org every few minutes) calls it directly, once
 *     per HTTP hit.
 *
 * Earlier this file tried to retry a failed generation with an in-process
 * `sleep()` between attempts — that cannot work under a serverless function's
 * hard duration limit (a single call could need 3x a multi-minute generation
 * timeout). Retries are instead expressed as "try once per call, and let
 * whatever's calling this again in a few minutes be the retry" — the
 * function itself just checks how many attempts have already failed since
 * today's scheduled moment and stops trying once that hits MAX_ATTEMPTS, no
 * in-memory state required at all.
 */

const MAX_ATTEMPTS = 3

function startOfUtcDay(): Date {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

function todaysScheduledMoment(scheduleHour: number, scheduleMinute: number): Date {
  const day = startOfUtcDay()
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), scheduleHour, scheduleMinute))
}

/** Mirrors the "already met today's target" gate scripts/runBlogAi.ts applies for the OS-cron path. */
async function todaysTargetAlreadyMet(postsPerDay: number): Promise<boolean> {
  try {
    const count = await prisma.blogAiRun.count({ where: { status: 'success', started_at: { gte: startOfUtcDay() } } })
    return count >= postsPerDay
  } catch (error) {
    logger.error("Blog AI scheduler: could not check today's run count — proceeding anyway:", error instanceof Error ? error.message : error)
    return false
  }
}

/**
 * Failed runs since TODAY'S SCHEDULED MOMENT specifically, not since
 * midnight — so an unrelated manual "Run Now" click earlier in the day
 * (before the schedule was even due) can't burn into the scheduled run's own
 * attempt budget.
 */
async function failedAttemptsSinceScheduledMoment(scheduledMoment: Date): Promise<number> {
  try {
    return await prisma.blogAiRun.count({ where: { status: 'failed', started_at: { gte: scheduledMoment } } })
  } catch (error) {
    logger.error('Blog AI scheduler: could not check failed-attempt count — proceeding anyway:', error instanceof Error ? error.message : error)
    return 0
  }
}

export type BlogAiSchedulerOutcome =
  | { generation: 'disabled' }
  | { generation: 'not_due' }
  | { generation: 'target_met' }
  | { generation: 'exhausted'; attempts: number }
  | { generation: 'ran'; success: boolean; error?: string }

/**
 * The single source of truth for "should a post generate right now" — called
 * by both trigger paths described above. Always runs the review-window
 * sweep first, independent of whether generation is due or even enabled
 * (matches scripts/runBlogAi.ts's existing behavior: a draft already
 * awaiting review still needs its timeout handled on a day nothing new
 * generates).
 */
export async function runDueBlogAiTasks(): Promise<BlogAiSchedulerOutcome> {
  await sweepExpiredDrafts().catch((error: unknown) => {
    logger.error('Blog AI scheduler: draft-review sweep crashed:', error instanceof Error ? error.message : error)
  })

  const settings = await blogAiService.getSettings()
  if (!settings.auto_blog_enabled) return { generation: 'disabled' }

  const scheduledMoment = todaysScheduledMoment(settings.schedule_hour, settings.schedule_minute)
  if (new Date() < scheduledMoment) return { generation: 'not_due' }

  if (await todaysTargetAlreadyMet(settings.posts_per_day)) return { generation: 'target_met' }

  const failedAttempts = await failedAttemptsSinceScheduledMoment(scheduledMoment)
  if (failedAttempts >= MAX_ATTEMPTS) return { generation: 'exhausted', attempts: failedAttempts }

  logger.info(`Blog AI scheduler: generating (attempt ${failedAttempts + 1}/${MAX_ATTEMPTS}, billing-safe/CLI-only).`)
  // Forces billingSafeOnly: an unattended scheduled run must never fall back
  // to a metered API-key account, no matter how many attempts it takes.
  const result = await runBlogAiEngine({ billingSafeOnly: true })

  if (result.success) {
    logger.info(`Blog AI scheduler: generation succeeded — "${String(result.draft?.['title'])}".`)
    return { generation: 'ran', success: true }
  }

  if (!result.started) {
    // e.g. another run already in progress — not a failed attempt, just not our turn.
    logger.info(`Blog AI scheduler: generation did not start — ${result.reason}`)
    return { generation: 'not_due' }
  }

  logger.error(`Blog AI scheduler: attempt ${failedAttempts + 1}/${MAX_ATTEMPTS} failed — ${result.error}`)
  return { generation: 'ran', success: false, error: result.error }
}

/**
 * Only meaningful on a persistent process (`npm start` on a VPS) — Vercel's
 * serverless entrypoint (api/index.js) never calls this at all, which is
 * exactly why the public /cron/trigger endpoint exists: something has to
 * actually invoke runDueBlogAiTasks() on a schedule, and a serverless
 * function can't hold its own timer. One poll every 5 minutes is frequent
 * enough that the schedule stays accurate to within a few minutes without
 * needing to recompute a cron expression whenever settings change — it just
 * re-reads settings fresh on every tick.
 */
export function armSchedulerPoller(): void {
  cron.schedule('*/5 * * * *', () => void runDueBlogAiTasks(), { timezone: 'UTC' })
  logger.info('Blog AI scheduler: polling every 5 minutes (in-process — only relevant on a persistent server, not Vercel).')
}

/** Called once at server boot (src/server.ts) — persistent-process path only. */
export async function initBlogAiScheduler(): Promise<void> {
  armSchedulerPoller()
}

export default { runDueBlogAiTasks, initBlogAiScheduler }
