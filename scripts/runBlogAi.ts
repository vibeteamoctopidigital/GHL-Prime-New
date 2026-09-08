

// This script is NOT compiled into dist/ (scripts/ is excluded from the
// production TypeScript build, same as scripts/seed.ts and
// scripts/refresh-sitemap.ts) — it runs directly via `tsx`, which is why
// `npm run blog-ai:cron` is the crontab entrypoint, not a `dist/` path.
//
// `POST /api/blog-ai/run-now` is a separate, ungated manual trigger for
// on-demand/testing use — it bypasses the schedule/backoff checks below
// entirely, unlike job #1 in this script. It does NOT run the sweep itself;
// waiting for/triggering this script is still how a review-window timeout
// gets tested.
import { disconnectDatabase } from '../src/config/supabase.js'
import supabase from '../src/config/supabase.js'
import blogAiService from '../src/modules/blog-ai/blogAi.service.js'
import { runBlogAiEngine } from '../src/modules/blog-ai/blogAi.engine.js'
import { sweepExpiredDrafts } from '../src/modules/blog-ai/blogAi.checker.js'
import logger from '../src/shared/utils/logger.js'

const FAILURE_RETRY_MINUTES = 30

function startOfUtcDay(): string {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString()
}

async function shouldRunNow(): Promise<{ run: boolean; reason?: string }> {
  const settings = await blogAiService.getSettings()
  const currentUtcHour = new Date().getUTCHours()

  const { count: doneToday, error: countError } = await supabase
    .from('blog_ai_runs')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'success')
    .gte('started_at', startOfUtcDay())

  if (countError) throw new Error(`Could not check today's run count: ${countError.message}`)

  if ((doneToday ?? 0) >= settings.posts_per_day) {
    return { run: false, reason: `today's target of ${settings.posts_per_day} post(s) already met (${doneToday} done)` }
  }

  if (currentUtcHour < settings.schedule_hour) {
    return {
      run: false,
      reason: `not yet the scheduled start hour (current UTC hour ${currentUtcHour} < schedule_hour ${settings.schedule_hour})`,
    }
  }

  const { data: recentFailures, error: failureError } = await supabase
    .from('blog_ai_runs')
    .select('id')
    .eq('status', 'failed')
    .gt('finished_at', new Date(Date.now() - FAILURE_RETRY_MINUTES * 60_000).toISOString())
    .order('finished_at', { ascending: false })
    .limit(1)

  if (failureError) throw new Error(`Could not check recent failures: ${failureError.message}`)
  if ((recentFailures ?? []).length) {
    return { run: false, reason: `retry backoff — waiting ${FAILURE_RETRY_MINUTES} minutes after last failure` }
  }

  return { run: true }
}

async function runGenerationIfDue(): Promise<void> {
  const gate = await shouldRunNow()
  if (!gate.run) {
    logger.info(`Blog AI: not due — ${gate.reason}`)
    return
  }

  const result = await runBlogAiEngine()
  if (!result.started) {
    logger.info(`Blog AI: skipped — ${result.reason}`)
  } else if (result.success) {
    logger.info(`Blog AI: draft created — "${String(result.draft?.['title'])}" (run ${result.runId})`)
  } else {
    logger.error(`Blog AI: failed — ${result.error} (run ${result.runId})`)
    process.exitCode = 1
  }
}

async function run(): Promise<void> {
  try {
    await runGenerationIfDue()
  } catch (error) {
    logger.error('Blog AI generation crashed:', error instanceof Error ? error.message : error)
    process.exitCode = 1
  }

  try {
    // Always runs, independent of whether generation happened above.
    await sweepExpiredDrafts()
  } catch (error) {
    logger.error('Blog AI checker sweep crashed:', error instanceof Error ? error.message : error)
    process.exitCode = 1
  } finally {
    await disconnectDatabase()
  }
}

await run()
