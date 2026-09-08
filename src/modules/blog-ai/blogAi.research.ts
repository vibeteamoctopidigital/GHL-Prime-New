import logger from '../../shared/utils/logger.js'
import { researchWithOpenAi } from './blogAi.providers.js'
import { researchWithClaudeCli, researchWithCodexCli } from './blogAi.cliRunner.js'
import { decryptToken } from '../../shared/utils/tokenCrypto.js'
import { researchResultSchema, type ResearchResult } from './blogAi.validators.js'
import type { BlogAiSettings, ProviderRuntime } from './blogAi.service.js'

/**
 * Picks ONE specific, high-search-intent topic before writing, using
 * whichever provider/account is already selected for this run's generation
 * — no separate account lookup. Best-effort by design: if research fails or
 * produces something unparseable, the caller just proceeds without an
 * assigned topic (the model falls back to picking freely within the
 * category list), same as before this feature existed. Never blocks a run.
 */
function buildResearchPrompt(focusAreas: string[], recentTitles: string[]): string {
  return [
    'Search the web for what is genuinely trending right now — news, launches, discussions — in these subject areas:',
    focusAreas.join(', '),
    '',
    'Do not pick anything overlapping with these already-covered posts:',
    recentTitles.length ? recentTitles.map((title) => `- ${title}`).join('\n') : '(none yet)',
    '',
    'Pick exactly ONE specific, high-search-intent angle (not a broad subject) that a blog post could cover right now with',
    'the best realistic chance of attracting readers and ranking on Google.',
    '',
    'After you finish searching, end your reply with a final line containing ONLY a JSON object, no markdown fences, in exactly this shape:',
    '{"topic": "the specific angle", "rationale": "why this, why now", "sources": ["https://...", "https://..."]}',
  ].join('\n')
}

/** Finds the last `{...}` block in free text and parses it — tolerant of the model "thinking out loud" first. */
function extractTrailingJson(text: string): unknown {
  const start = text.lastIndexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return null

  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

export async function researchTopic(opts: {
  runtime: ProviderRuntime
  settings: BlogAiSettings
  focusAreas: string[]
  recentTitles: string[]
}): Promise<ResearchResult | null> {
  const prompt = buildResearchPrompt(opts.focusAreas, opts.recentTitles)
  const { runtime, settings } = opts

  try {
    let rawText: string
    switch (runtime.transport) {
      case 'claude-cli':
        rawText = await researchWithClaudeCli({
          prompt,
          token: decryptToken(runtime.account.token),
          authType: runtime.account.auth_type,
          model: runtime.account.model || settings.anthropic_model || undefined,
          cliPath: settings.claude_cli_command || undefined,
        })
        break
      case 'codex-cli':
        rawText = await researchWithCodexCli({
          prompt,
          model: settings.openai_model || undefined,
          cliPath: settings.codex_cli_command || undefined,
        })
        break
      case 'openai-api':
        rawText = await researchWithOpenAi({
          apiKey: decryptToken(runtime.account.token),
          model: runtime.account.model || settings.openai_model || undefined,
          prompt,
        })
        break
    }

    const parsed = researchResultSchema.safeParse(extractTrailingJson(rawText))
    if (!parsed.success) {
      logger.warn('Blog AI research: could not parse a topic from the response — proceeding without an assigned topic.')
      return null
    }

    return parsed.data
  } catch (error) {
    // Research is a nice-to-have layered on top of generation — never let it
    // block a run. Log and let the caller fall back to no assigned topic.
    logger.warn('Blog AI research step failed, proceeding without an assigned topic:', error instanceof Error ? error.message : error)
    return null
  }
}

export default researchTopic
