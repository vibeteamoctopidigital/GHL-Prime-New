import cron, { type ScheduledTask } from 'node-cron'
import supabase from '../../config/supabase.js'
import logger from '../../shared/utils/logger.js'
import blogAiService, { type BlogAiSettings } from './blogAi.service.js'
import { runBlogAiEngine } from './blogAi.engine.js'
import { sweepExpiredDrafts } from './blogAi.checker.js'

/**
 * The in-process daily scheduler for Auto Blog. Deliberately NOT the same
 * mechanism as `scripts/runBlogAi.ts` (the OS-crontab entrypoint some VPS
 * setups may still point a real crontab at) — that script only takes effect
 * after an admin edits the crontab by hand. This scheduler lives inside the
 * long-running API process itself, reads its schedule from
 * blog_ai_settings, and re-arms itself the moment an admin changes the
 * schedule from the Auto Blog page (see rescheduleBlogAiCron(), called from
 * blogAi.controller.ts's updateSettings handler) — "auto update in backend"
 * with no server restart and no shell access required.
 *
 * Running both this AND a real crontab entry pointed at the old script is
 * possible but redundant — pick one. This one is the one the dashboard's
 * schedule UI actually controls.
 */

const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 15_000

let currentTask: ScheduledTask | null = null

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function startOfUtcDay(): string {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString()
}

/** Mirrors the "already met today's target" gate scripts/runBlogAi.ts applies for the OS-cron path. */
async function todaysTargetAlreadyMet(postsPerDay: number): Promise<boolean> {
  const { count, error } = await supabase
    .from('blog_ai_runs')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'success')
    .gte('started_at', startOfUtcDay())

  if (error) {
    logger.error('Blog AI scheduler: could not check today\'s run count — proceeding anyway:', error.message)
    return false
  }

  return (count ?? 0) >= postsPerDay
}

/**
 * Fires once at the scheduled time. Retries on failure — at least once
 * (2 attempts total) and never more than MAX_ATTEMPTS — since a transient
 * hiccup (a brief network blip, a CLI cold-start timeout) shouldn't cost an
 * entire day's post. Forces `billingSafeOnly: true` on every attempt: an
 * unattended scheduled run must never fall back to a metered API-key
 * account, no matter how many attempts it takes.
 */
async function runScheduledGeneration(): Promise<void> {
  const settings = await blogAiService.getSettings()

  if (!settings.auto_blog_enabled) {
    logger.info('Blog AI scheduler: tick fired but Auto Blog is turned off in settings — skipping.')
    return
  }

  if (await todaysTargetAlreadyMet(settings.posts_per_day)) {
    logger.info(`Blog AI scheduler: today's target of ${settings.posts_per_day} post(s) already met — skipping.`)
    return
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    logger.info(`Blog AI scheduler: starting scheduled run (attempt ${attempt}/${MAX_ATTEMPTS}, billing-safe/CLI-only).`)
    const result = await runBlogAiEngine({ billingSafeOnly: true })

    if (result.success) {
      logger.info(`Blog AI scheduler: scheduled run succeeded on attempt ${attempt} — "${String(result.draft?.['title'])}".`)
      return
    }

    if (!result.started) {
      // e.g. another run already in progress — retrying immediately won't help.
      logger.info(`Blog AI scheduler: scheduled run did not start — ${result.reason}`)
      return
    }

    logger.error(`Blog AI scheduler: attempt ${attempt}/${MAX_ATTEMPTS} failed — ${result.error}`)
    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS)
  }

  logger.error(`Blog AI scheduler: gave up after ${MAX_ATTEMPTS} failed attempts. Check the Recent Runs list — an alert email was already sent by the engine.`)
}

function cronExpressionFor(settings: BlogAiSettings): string {
  return `${settings.schedule_minute} ${settings.schedule_hour} * * *`
}

/**
 * Stops whatever schedule is currently armed and arms a new one from
 * `settings` — or arms nothing if Auto Blog is turned off. Safe to call
 * repeatedly (e.g. every time settings are saved, whether or not the
 * schedule actually changed).
 */
export function rescheduleBlogAiCron(settings: BlogAiSettings): void {
  currentTask?.stop()
  currentTask = null

  if (!settings.auto_blog_enabled) {
    logger.info('Blog AI scheduler: Auto Blog is turned off — no schedule armed.')
    return
  }

  const expression = cronExpressionFor(settings)
  currentTask = cron.schedule(expression, () => void runScheduledGeneration(), { timezone: 'UTC' })

  const hh = String(settings.schedule_hour).padStart(2, '0')
  const mm = String(settings.schedule_minute).padStart(2, '0')
  logger.info(`Blog AI scheduler: armed for ${hh}:${mm} UTC daily (up to ${settings.posts_per_day} post/day, ${MAX_ATTEMPTS} attempts max on failure).`)
}

/**
 * Independent of the daily generation schedule and NOT gated on
 * `auto_blog_enabled`: a draft already sitting in `pending_review` still
 * needs its review-window timeout handled (handing it to the AI-checker)
 * even on a day nothing new is generated, or while auto-generation is
 * turned off. Runs every 5 minutes, matching the cadence docs/BLOG_AI.md
 * previously only got from an external VPS crontab entry — arming it here
 * too means that crontab entry is now optional, not load-bearing.
 */
function armSweepInterval(): void {
  cron.schedule(
    '*/5 * * * *',
    () =>
      void sweepExpiredDrafts().catch((error: unknown) => {
        logger.error('Blog AI scheduler: draft-review sweep crashed:', error instanceof Error ? error.message : error)
      }),
    { timezone: 'UTC' },
  )
}

/** Called once at server boot — loads the current settings, arms the daily schedule, and starts the always-on review sweep. */
export async function initBlogAiScheduler(): Promise<void> {
  const settings = await blogAiService.getSettings()
  rescheduleBlogAiCron(settings)
  armSweepInterval()
}

export default { rescheduleBlogAiCron, initBlogAiScheduler }
