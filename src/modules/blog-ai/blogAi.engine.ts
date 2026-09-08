import supabase from '../../config/supabase.js'
import env from '../../config/env.js'
import logger from '../../shared/utils/logger.js'
import { decryptToken } from '../../shared/utils/tokenCrypto.js'
import { buildUniqueSlug } from '../../shared/utils/slug.js'
import { sanitizeWriting } from '../../shared/utils/textSanitize.js'
import { sendAdminAlert } from '../../shared/utils/mailer.js'
import blogService from '../blog/blog.service.js'
import blogAiService, { type BlogAiSettings, type ProviderRuntime } from './blogAi.service.js'
import { invokeOpenAI } from './blogAi.providers.js'
import { invokeClaudeCli, invokeCodexCli } from './blogAi.cliRunner.js'
import { researchTopic } from './blogAi.research.js'
import { generateCoverImage } from './blogAi.images.js'
import { guardLinks } from './blogAi.linkGuard.js'
import { aiPostSchema, buildAiPostJsonSchema, type AiPostOutput, type BlogAiProvider, type ResearchResult } from './blogAi.validators.js'
import type { SerializedRow } from '../../types/common.js'

interface InternalLinkCandidate {
  title: string
  url: string
}


const RUN_STALE_MINUTES = 15 
const COOLDOWN_MINUTES = 20 

export interface RunResult {
  started: boolean
  reason?: string
  success?: boolean
  runId?: string
  draft?: SerializedRow
  error?: string
}

/**
 * Records which phase a run is in, so the dashboard can show progress while
 * the (multi-minute) run is still in flight. Best-effort by design — a
 * failed progress write must never abort the actual generation.
 */
export const RUN_STEPS = ['researching', 'writing', 'reviewing_content', 'generating_image', 'saving_draft'] as const
export type RunStep = (typeof RUN_STEPS)[number]

async function setRunStep(runId: string, step: RunStep): Promise<void> {
  const { error } = await supabase.from('blog_ai_runs').update({ current_step: step }).eq('id', runId)
  if (error) logger.warn(`Blog AI: could not record run step "${step}":`, error.message)
}

async function isAlreadyRunning(): Promise<boolean> {
  const { data, error } = await supabase
    .from('blog_ai_runs')
    .select('id')
    .eq('status', 'running')
    .gt('started_at', new Date(Date.now() - RUN_STALE_MINUTES * 60_000).toISOString())
    .limit(1)

  if (error) throw new Error(`Could not check in-progress runs: ${error.message}`)
  return (data ?? []).length > 0
}

function buildPrompt(
  settings: BlogAiSettings,
  recentPosts: { title: string; category: string }[],
  assignedTopic: ResearchResult | null,
  internalLinkCandidates: InternalLinkCandidate[],
): string {
  const recentList = recentPosts.length
    ? recentPosts.map((post) => `- "${post.title}" (${post.category})`).join('\n')
    : '(none published yet)'

  const internalLinksList = internalLinkCandidates.length
    ? internalLinkCandidates.map((link) => `- "${link.title}" -> ${link.url}`).join('\n')
    : '(no other posts published yet — do not invent internal links)'

  return [
    'You are an expert SEO content writer for GHL Prime, a GoHighLevel consulting and automation agency.',
    'Write ONE new, original, SEO-optimized blog post.',
    '',
    `The "category" field MUST be exactly one of: ${settings.categories.join(', ')}.`,
    '',
    ...(assignedTopic
      ? [
          'Write specifically about this topic — it was chosen via live web research as the angle with the best chance of',
          'attracting readers and ranking well right now. Do not substitute a different topic.',
          `Assigned topic: ${assignedTopic.topic}`,
          `Why this topic: ${assignedTopic.rationale}`,
          '',
        ]
      : []),
    'CORE CONTENT RULES — every one of these is mandatory, not a suggestion:',
    '1. Never produce harmful, dangerous, abusive, hateful, illegal, or otherwise inappropriate content.',
    '2. Pick ONE primary focus keyword ("primary_keyword") and write around genuine reader search intent for it — never keyword-stuff.',
    '   The primary keyword must appear naturally in: the title, the slug, seo_title, seo_description, the opening paragraph, and at least one heading.',
    '3. Titles and the seo_title must be compelling and keyword-focused for strong Google CTR, but never misleading clickbait —',
    '   they must accurately represent what the article actually delivers.',
    '4. Heading structure: the title is the page\'s only H1 (it is rendered separately from "content"). The "content" field must',
    '   NEVER contain an <h1>. Body headings start at <h2> and nest logically — an <h3> only ever follows a preceding <h2>, no skipped levels.',
    '5. Write for readability: short paragraphs, useful lists/formatting, plain language, originality, and genuine usefulness —',
    '   the kind of content Google rewards for satisfying real search intent, not thin or generic filler.',
    `6. You may cite up to ${settings.max_internal_links} internal links FROM THE LIST BELOW ONLY, where genuinely relevant — never invent a URL.`,
    '7. You may add a small number of external links to credible, non-competing sources for facts or citations.',
    `   NEVER link to any of these competitor domains, under any circumstances, however relevant they seem: ${settings.competitor_domains.length ? settings.competitor_domains.join(', ') : '(none configured — still avoid obvious direct competitors of a GoHighLevel/CRM/automation agency)'}.`,
    '   If you are not fully sure a source is not a competitor, do not link to it.',
    '',
    'Internal links you may cite (use naturally, only if relevant, do not force all of them in):',
    internalLinksList,
    '',
    'Writing style rules (must follow exactly):',
    settings.style_rules.trim() || '(none provided)',
    '',
    'Admin instructions:',
    settings.instructions.trim() || '(none provided)',
    '',
    'Target keywords / SEO focus:',
    settings.keywords.trim() || '(none provided)',
    '',
    'Additional / advanced instructions:',
    settings.advanced_instructions.trim() || '(none provided)',
    '',
    'Avoid repeating the topic of these recently published posts:',
    recentList,
    '',
    'Field requirements:',
    '- "title": compelling, specific, attention-grabbing, under 70 characters, contains the primary keyword.',
    '- "slug": lowercase, hyphenated URL slug derived from the title, ideally containing the primary keyword.',
    '- "primary_keyword": the single SEO focus keyword/phrase for this post.',
    '- "content": valid HTML (headings, paragraphs, lists as appropriate) ready to render directly on the site — no markdown, no code fences, no <html>/<body> wrapper.',
    '- "excerpt": a 1-2 sentence summary, under 160 characters.',
    '- "tags": an array of 3-6 short lowercase strings.',
    '- "seo_title": under 60 characters, contains the primary keyword, written to rank well on Google.',
    '- "seo_description": under 160 characters, contains the primary keyword, written to rank well on Google.',
    '- "seo_keywords": a comma-separated string — the primary keyword plus relevant secondary keywords.',
  ].join('\n')
}

function computeReadingTime(html: string): number {
  const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  const wordCount = text ? text.split(' ').length : 0
  return Math.max(1, Math.round(wordCount / 200))
}

function parseAiResponse(raw: string): AiPostOutput {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`AI response was not valid JSON (${message}). First 500 chars: ${cleaned.slice(0, 500)}`)
  }

  const result = aiPostSchema.safeParse(parsed)
  if (!result.success) {
    const missing = result.error.issues.map((issue) => issue.path.join('.') || '(root)').join(', ')
    throw new Error(`AI response is missing/invalid required field(s): ${missing}`)
  }

  return result.data
}

/** Dispatches the actual write call to whichever transport the runtime resolved to. */
async function callWriter(runtime: ProviderRuntime, settings: BlogAiSettings, prompt: string, jsonSchema: Record<string, unknown>): Promise<string> {
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

/** Deterministic style cleanup on every text field, regardless of prompt compliance. */
function sanitizeGenerated(generated: AiPostOutput): AiPostOutput {
  return {
    ...generated,
    title: sanitizeWriting(generated.title),
    excerpt: sanitizeWriting(generated.excerpt),
    content: sanitizeWriting(generated.content),
    seo_title: sanitizeWriting(generated.seo_title),
    seo_description: sanitizeWriting(generated.seo_description),
  }
}

export async function runBlogAiEngine(): Promise<RunResult> {
  if (await isAlreadyRunning()) {
    return {
      started: false,
      reason: 'A blog AI run is already in progress (started within the last 15 minutes). Try again shortly.',
    }
  }

  const { data: runRow, error: runInsertError } = await supabase
    .from('blog_ai_runs')
    .insert({ status: 'running' })
    .select('id')
    .single()

  if (runInsertError || !runRow) {
    throw new Error(`Could not start a run: ${runInsertError?.message ?? 'no row returned'}`)
  }
  const runId = runRow['id'] as string

  let runtime: ProviderRuntime | null = null
  let provider: BlogAiProvider | null = null

  try {
    const settings = await blogAiService.getSettings()

    const { data: recentPosts } = await supabase
      .from('blog_posts')
      .select('title, category, slug')
      .eq('published', true)
      .order('published_at', { ascending: false })
      .limit(30)

    runtime = await blogAiService.resolveProviderRuntime(settings.primary_provider)

    if (!runtime && settings.fallback_enabled) {
      const fallbackProvider: BlogAiProvider = settings.primary_provider === 'anthropic' ? 'openai' : 'anthropic'
      runtime = await blogAiService.resolveProviderRuntime(fallbackProvider)
    }

    if (!runtime) {
      const message =
        'No available provider: no connected Claude account, no active Codex login, and no fallback available.'

      await sendAdminAlert({
        subject: 'CRITICAL: Auto Blog has no working AI provider',
        text: `${message}\n\nAuto Blog cannot generate any posts until an account is connected or re-enabled.`,
      })

      throw new Error(message)
    }

    provider = runtime.provider
    const typedRecentPosts = (recentPosts ?? []) as { title: string; category: string; slug: string }[]

    const internalLinkCandidates: InternalLinkCandidate[] = typedRecentPosts
      .slice(0, 15)
      .map((post) => ({ title: post.title, url: `${env.SITE_URL}${settings.blog_url_path}/${post.slug}` }))

    let assignedTopic: ResearchResult | null = null
    if (settings.web_search_enabled) {
      await setRunStep(runId, 'researching')
      assignedTopic = await researchTopic({
        runtime,
        settings,
        focusAreas: settings.topic_focus_areas,
        recentTitles: typedRecentPosts.map((post) => post.title),
      })
    }

    const prompt = buildPrompt(settings, typedRecentPosts, assignedTopic, internalLinkCandidates)
    const jsonSchema = buildAiPostJsonSchema(settings.categories)

    await setRunStep(runId, 'writing')
    const resultText = await callWriter(runtime, settings, prompt, jsonSchema)

    await setRunStep(runId, 'reviewing_content')
    const sanitized = sanitizeGenerated(parseAiResponse(resultText))

    // Hard-enforced, not just prompted: cap internal links, strip any
    // competitor-domain link outright, and downgrade a stray <h1> if one
    // slipped through — see blogAi.linkGuard.ts.
    const linkGuardResult = guardLinks(sanitized.content, {
      siteUrl: env.SITE_URL,
      competitorDomains: settings.competitor_domains,
      maxInternalLinks: settings.max_internal_links,
    })
    const generated = { ...sanitized, content: linkGuardResult.html }

    if (linkGuardResult.strippedCompetitorLinks.length || linkGuardResult.strippedExcessInternalLinks || linkGuardResult.demotedH1Count) {
      logger.warn('Blog AI: link/heading guard made corrections to a generated post:', {
        strippedCompetitorLinks: linkGuardResult.strippedCompetitorLinks,
        strippedExcessInternalLinks: linkGuardResult.strippedExcessInternalLinks,
        demotedH1Count: linkGuardResult.demotedH1Count,
      })
    }

    // Resolve the slug up front (with collision-safe suffixing via the same
    // helper the blog/case-studies modules already use) so it's already
    // unique by the time a human or the checker approves the draft.
    const slug = await buildUniqueSlug(generated.slug || generated.title, (candidate) => blogService.exists({ slug: candidate }), 'post')

    // Cover images always need a real OpenAI API key — Claude cannot
    // generate images under any plan, and the ambient Codex login has no
    // image capability either. Falls back to an admin-configured placeholder
    // rather than leaving the post with no cover at all.
    let coverImage: { url: string; alt: string } | null = null
    if (settings.image_generation_enabled) {
      await setRunStep(runId, 'generating_image')
      const imageAccount = await blogAiService.pickAvailableAccount('openai')
      if (imageAccount) {
        coverImage = await generateCoverImage({
          apiKey: decryptToken(imageAccount.token),
          model: imageAccount.model || settings.openai_model || undefined,
          title: generated.title,
          excerpt: generated.excerpt,
        })
      } else {
        logger.warn('Blog AI: image generation is enabled but no OpenAI API key account is configured — using the placeholder cover image.')
      }
    }
    if (!coverImage && settings.placeholder_cover_image_url) {
      coverImage = { url: settings.placeholder_cover_image_url, alt: `Cover image for: ${generated.title}` }
    }

    await setRunStep(runId, 'saving_draft')
    const reviewDeadline = new Date(Date.now() + settings.review_window_minutes * 60_000).toISOString()

    const { data: draftRow, error: draftError } = await supabase
      .from('blog_ai_drafts')
      .insert({
        run_id: runId,
        provider,
        title: generated.title,
        slug,
        category: generated.category,
        primary_keyword: generated.primary_keyword,
        tags: generated.tags,
        excerpt: generated.excerpt,
        content: generated.content,
        seo_title: generated.seo_title,
        seo_description: generated.seo_description,
        seo_keywords: generated.seo_keywords,
        reading_time: computeReadingTime(generated.content),
        topic_research: assignedTopic,
        cover_image: coverImage?.url ?? null,
        cover_image_alt: coverImage?.alt ?? null,
        status: 'pending_review',
        review_deadline: reviewDeadline,
      })
      .select('*')
      .single()

    if (draftError || !draftRow) {
      throw new Error(`Generated content but could not save the draft: ${draftError?.message ?? 'no row returned'}`)
    }

    await supabase
      .from('blog_ai_runs')
      .update({
        status: 'success',
        provider,
        account_label: 'account' in runtime ? runtime.account.label : 'codex (ambient login)',
        current_step: null,
        finished_at: new Date().toISOString(),
      })
      .eq('id', runId)

    if ('account' in runtime) {
      await supabase
        .from('blog_ai_accounts')
        .update({ done_count: runtime.account.done_count + 1, last_used_at: new Date().toISOString(), status: 'idle' })
        .eq('id', runtime.account.id)
    }

    return { started: true, success: true, runId, draft: draftRow as unknown as SerializedRow }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error('Blog AI run failed:', message)

    await supabase
      .from('blog_ai_runs')
      .update({ status: 'failed', provider, error: message, current_step: null, finished_at: new Date().toISOString() })
      .eq('id', runId)

    if (runtime && 'account' in runtime) {
      const account = runtime.account
      await supabase
        .from('blog_ai_accounts')
        .update({
          failed_count: account.failed_count + 1,
          cooldown_until: new Date(Date.now() + COOLDOWN_MINUTES * 60_000).toISOString(),
          status: 'disabled_cooldown',
          last_error: message,
        })
        .eq('id', account.id)
    }

    await notifyRunFailure(runId, message)

    return { started: true, success: false, runId, error: message }
  }
}

/**
 * Emails the admin about a failed run, but not on every single tick while a
 * provider stays broken — skips if a failure alert already went out in the
 * last 30 minutes (blog_ai_runs.alerted_at), then stamps the run so the
 * next one knows.
 */
async function notifyRunFailure(runId: string, message: string): Promise<void> {
  const { data: recentAlert } = await supabase
    .from('blog_ai_runs')
    .select('id')
    .not('alerted_at', 'is', null)
    .gt('alerted_at', new Date(Date.now() - 30 * 60_000).toISOString())
    .limit(1)

  if ((recentAlert ?? []).length > 0) return

  await sendAdminAlert({
    subject: 'Auto Blog run failed',
    text: `A Auto Blog generation run failed:\n\n${message}\n\nRun ID: ${runId}`,
  })

  await supabase.from('blog_ai_runs').update({ alerted_at: new Date().toISOString() }).eq('id', runId)
}

export default runBlogAiEngine
