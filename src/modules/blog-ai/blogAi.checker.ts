import logger from '../../shared/utils/logger.js'
import { decryptToken } from '../../shared/utils/tokenCrypto.js'
import { sendAdminAlert } from '../../shared/utils/mailer.js'
import blogAiService, { type BlogAiSettings, type ProviderRuntime } from './blogAi.service.js'
import blogAiDraftsService from './blogAi.drafts.service.js'
import { invokeOpenAI } from './blogAi.providers.js'
import { invokeClaudeCli, invokeCodexCli } from './blogAi.cliRunner.js'
import { buildCheckerJsonSchema, checkerResultSchema, type BlogAiProvider, type CheckerResult } from './blogAi.validators.js'
import type { SerializedRow } from '../../types/common.js'



export interface CheckOutcome {
  pass: boolean
  result?: CheckerResult
  skippedReason?: string
}

function buildCheckerPrompt(draft: SerializedRow, settings: BlogAiSettings): string {
  return [
    'You are a strict editor reviewing a blog post an AI wrote for GHL Prime before it goes live.',
    'Review it against every rule below and reply with ONLY the required JSON verdict.',
    '',
    'Writing style rules the post MUST follow:',
    settings.style_rules,
    '',
    `Minimum acceptable SEO score: ${settings.min_seo_score}/100.`,
    `Max internal links allowed: ${settings.max_internal_links} (already hard-capped upstream, but flag if it looks forced/unnatural).`,
    `Competitor domains that must NEVER be linked (already hard-blocked upstream, but flag if you spot one that slipped through or an obvious competitor mention as a link): ${settings.competitor_domains.join(', ') || '(none configured)'}.`,
    '',
    `Title: ${String(draft['title'])}`,
    `Category: ${String(draft['category'])}`,
    `Primary keyword: ${String(draft['primary_keyword'] ?? '(missing)')}`,
    `SEO title: ${String(draft['seo_title'])}`,
    `SEO description: ${String(draft['seo_description'])}`,
    `Excerpt: ${String(draft['excerpt'])}`,
    '',
    'Full content (HTML):',
    String(draft['content']),
    '',
    'Fail the post ("pass": false) if ANY of the following is true:',
    '- It violates the style rules (e.g. contains an em dash).',
    '- It contains harmful, dangerous, abusive, hateful, illegal, or otherwise inappropriate content.',
    '- The primary keyword is missing, or does not naturally appear in the title AND the SEO title.',
    '- The title or SEO title is misleading clickbait that does not match what the content actually delivers.',
    '- The content HTML contains an <h1>, or headings are not properly nested (an <h3> appearing without a preceding <h2>).',
    '- It reads incoherently, is off-topic for its category, is thin/generic filler, or its actual SEO quality would fall below the minimum score.',
  ].join('\n')
}

/** Dispatches the checker call to whichever transport the runtime resolved to — same idea as blogAi.engine.ts's callWriter(). */
async function callChecker(runtime: ProviderRuntime, settings: BlogAiSettings, prompt: string, jsonSchema: Record<string, unknown>): Promise<string> {
  switch (runtime.transport) {
    case 'claude-cli':
      return invokeClaudeCli({
        prompt,
        jsonSchema,
        token: decryptToken(runtime.account.token),
        authType: runtime.account.auth_type,
        model: runtime.account.model || settings.anthropic_model || undefined,
        cliPath: settings.claude_cli_command || undefined,
      })
    case 'codex-cli':
      return invokeCodexCli({ prompt, jsonSchema, model: settings.openai_model || undefined, cliPath: settings.codex_cli_command || undefined })
    case 'openai-api':
      return invokeOpenAI({
        apiKey: decryptToken(runtime.account.token),
        model: runtime.account.model || settings.openai_model || undefined,
        prompt,
        jsonSchema,
      })
  }
}

export async function checkDraft(draft: SerializedRow, settings: BlogAiSettings): Promise<CheckOutcome> {
  const writerProvider = draft['provider'] as BlogAiProvider
  const otherProvider: BlogAiProvider = writerProvider === 'anthropic' ? 'openai' : 'anthropic'

  // No independent reviewer available — fall back to the same provider
  // rather than skipping the check entirely.
  const runtime = (await blogAiService.resolveProviderRuntime(otherProvider)) ?? (await blogAiService.resolveProviderRuntime(writerProvider))

  if (!runtime) {
    return { pass: false, skippedReason: 'No AI account available to run the second-opinion review on either provider.' }
  }

  try {
    const prompt = buildCheckerPrompt(draft, settings)
    const jsonSchema = buildCheckerJsonSchema()

    const resultText = await callChecker(runtime, settings, prompt, jsonSchema)

    const cleaned = resultText
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim()

    const parsed = checkerResultSchema.safeParse(JSON.parse(cleaned))
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => issue.path.join('.') || '(root)').join(', ')
      return { pass: false, skippedReason: `Checker response was invalid: ${issues}` }
    }

    return { pass: parsed.data.pass && parsed.data.seo_score >= settings.min_seo_score, result: parsed.data }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { pass: false, skippedReason: `Checker call failed: ${message}` }
  }
}

/**
 * Runs on every cron tick (scripts/runBlogAi.ts), independent of whether a
 * new post was also generated this tick. One bad draft never blocks the
 * rest — each is handled in its own try/catch.
 */
export async function sweepExpiredDrafts(): Promise<void> {
  const expired = await blogAiDraftsService.listExpiredPendingDrafts()
  if (expired.length === 0) return

  const settings = await blogAiService.getSettings()

  for (const candidate of expired) {
    try {
      // Atomically claims the draft (pending_review -> checking) so an
      // overlapping sweep can never process the same one twice.
      const draft = await blogAiDraftsService.claimForChecking(candidate['id'] as string)
      if (!draft) continue

      const outcome = await checkDraft(draft, settings)

      if (outcome.pass) {
        await blogAiDraftsService.publishDraft(draft, null)
        logger.info(`Blog AI checker: published draft "${String(draft['title'])}" (${draft['id']})`)
        continue
      }

      await blogAiDraftsService.markCheckerFailed(draft['id'] as string, outcome)

      await sendAdminAlert({
        subject: 'Auto Blog draft needs manual review',
        text: [
          `A draft's review window expired and the automated check did not pass:`,
          '',
          `Title: ${String(draft['title'])}`,
          `Draft ID: ${String(draft['id'])}`,
          '',
          outcome.result
            ? `SEO score: ${outcome.result.seo_score}\nIssues: ${outcome.result.issues.join('; ') || '(none listed)'}`
            : `Reason: ${outcome.skippedReason}`,
        ].join('\n'),
      })
    } catch (error) {
      logger.error(`Blog AI checker: sweep failed for draft ${String(candidate['id'])}:`, error instanceof Error ? error.message : error)
    }
  }
}

export default sweepExpiredDrafts
