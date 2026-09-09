import { z } from 'zod'
import { booleanish, optionalString } from '../../shared/validators/common.validators.js'

export const BLOG_AI_PROVIDERS = ['anthropic', 'openai'] as const
export type BlogAiProvider = (typeof BLOG_AI_PROVIDERS)[number]

/**
 * 'oauth' (default) = a Claude Code subscription login, billed flat-rate.
 * 'api_key' = a plain Anthropic/OpenAI API key, metered per token — the
 * advanced/fallback path. Both are stored the same way in blog_ai_accounts,
 * only auth_type differs in which credential env var the CLI call sets.
 */
export const AUTH_TYPES = ['oauth', 'api_key'] as const
export type AuthType = (typeof AUTH_TYPES)[number]

/**
 * Starting point only — admins edit this list from the settings page
 * (`blog_ai_settings.categories`), so unlike the CLI-based version this
 * repo ported from, there is no separate frontend copy to keep in sync by hand.
 */
export const DEFAULT_BLOG_CATEGORIES = [
  'GoHighLevel',
  'Automation',
  'AI Agents',
  'Case Studies',
  'Voice AI',
  'CRM',
  'Vibe Coding',
]

export const updateSettingsSchema = z.object({
  instructions: optionalString,
  keywords: optionalString,
  advancedInstructions: optionalString,
  categories: z.array(z.string().trim().min(1)).min(1).optional(),
  /** Master on/off switch for the daily scheduled run — Run Now ignores this and always works. */
  autoBlogEnabled: booleanish.optional(),
  scheduleHour: z.coerce.number().int().min(0).max(23).optional(),
  /** Minute component of the daily schedule, alongside scheduleHour — both interpreted as UTC. */
  scheduleMinute: z.coerce.number().int().min(0).max(59).optional(),
  postsPerDay: z.coerce.number().int().min(1).max(10).optional(),
  primaryProvider: z.enum(BLOG_AI_PROVIDERS).optional(),
  fallbackEnabled: booleanish.optional(),
  anthropicModel: optionalString,
  openaiModel: optionalString,
  // -- Auto Blog v2: review workflow, style rules, research, images --------
  styleRules: optionalString,
  topicFocusAreas: z.array(z.string().trim().min(1)).min(1).optional(),
  reviewWindowMinutes: z.coerce.number().int().min(1).max(1440).optional(),
  imageGenerationEnabled: booleanish.optional(),
  webSearchEnabled: booleanish.optional(),
  minSeoScore: z.coerce.number().int().min(0).max(100).optional(),
  // -- Content-quality rules: SEO/link/formatting policy -------------------
  /** Domains that must never appear as an outbound link, however relevant — hard-enforced, not just prompted. */
  competitorDomains: z.array(z.string().trim().min(1)).optional(),
  /** Max internal (own-site) links the writer may cite per post — hard-enforced. */
  maxInternalLinks: z.coerce.number().int().min(0).max(10).optional(),
  /** Path prefix for building internal blog links from a slug, e.g. "/blog". */
  blogUrlPath: optionalString,
  // -- CLI/subscription-based accounts --------------------------------------
  claudeCliCommand: optionalString,
  codexCliCommand: optionalString,
  codexEnabled: booleanish.optional(),
  placeholderCoverImageUrl: optionalString,
})
export type UpdateSettingsBody = z.infer<typeof updateSettingsSchema>

/**
 * `provider` optional (defaults to 'anthropic') and `token` accepted as an
 * alias for `apiKey`: the existing admin dashboard's "Add account" form
 * (built for the old CLI-based backend) posts `{ label, token, model }` with
 * no `provider` field at all, since that page only ever added Claude
 * accounts. Any other unrecognized field the old form sends (e.g.
 * `auth_type`) is silently ignored — zod strips unknown keys by default.
 */
export const createAccountSchema = z
  .object({
    label: z.string().trim().min(1, 'Label is required'),
    provider: z.enum(BLOG_AI_PROVIDERS).optional(),
    apiKey: z.string().trim().min(1).optional(),
    token: z.string().trim().min(1).optional(),
    authType: z.enum(AUTH_TYPES).optional(),
    auth_type: z.enum(AUTH_TYPES).optional(),
    model: optionalString,
  })
  .refine((data) => Boolean(data.apiKey || data.token), { message: 'API key is required', path: ['apiKey'] })
  .transform((data) => ({
    label: data.label,
    provider: data.provider ?? ('anthropic' as const),
    apiKey: (data.apiKey ?? data.token) as string,
    authType: data.authType ?? data.auth_type ?? ('oauth' as const),
    model: data.model,
  }))
export type CreateAccountBody = z.infer<typeof createAccountSchema>

export const updateAccountSchema = z.object({
  label: z.string().trim().min(1).optional(),
  model: optionalString,
  enabled: booleanish.optional(),
})
export type UpdateAccountBody = z.infer<typeof updateAccountSchema>

export const listRunsQuerySchema = z
  .object({
    limit: z.coerce.number().int().positive().max(200).optional(),
  })
  .passthrough()
export type ListRunsQuery = z.infer<typeof listRunsQuerySchema>

/**
 * A draft's lifecycle: written by the engine (pending_review) -> either an
 * admin decides (approved/rejected) within the review window, or the window
 * expires and the sweep hands it to the AI-checker (checking ->
 * checker_failed, or straight through to published on a pass).
 */
export const DRAFT_STATUSES = ['pending_review', 'checking', 'checker_failed', 'approved', 'rejected', 'published'] as const
export type DraftStatus = (typeof DRAFT_STATUSES)[number]

export const listDraftsQuerySchema = z
  .object({
    status: z.enum(DRAFT_STATUSES).optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
  })
  .passthrough()
export type ListDraftsQuery = z.infer<typeof listDraftsQuerySchema>

/**
 * Shape the AI must reply with — the single source of truth for both the
 * validation on the way back (safeParse) and, via buildAiPostJsonSchema()
 * below, the structured-output schema handed to the provider itself.
 */
export const aiPostSchema = z.object({
  title: z.string().trim().min(1),
  slug: z.string().trim().optional(),
  category: z.string().trim().min(1),
  primary_keyword: z.string().trim().min(1),
  tags: z.array(z.string().trim().min(1)).default([]),
  excerpt: z.string().trim().default(''),
  content: z.string().trim().min(1),
  seo_title: z.string().trim().default(''),
  seo_description: z.string().trim().default(''),
  seo_keywords: z.string().trim().default(''),
})
export type AiPostOutput = z.infer<typeof aiPostSchema>

/**
 * JSON Schema mirror of aiPostSchema, for providers that take a raw schema
 * (Claude tool-use `input_schema`, OpenAI Structured Outputs). Kept next to
 * aiPostSchema, in the same file, so the two shapes can't silently drift.
 */
/** What the topic-research step must produce — best-effort, parsed defensively (see blogAi.research.ts). */
export const researchResultSchema = z.object({
  topic: z.string().trim().min(1),
  rationale: z.string().trim().default(''),
  sources: z.array(z.string()).default([]),
})
export type ResearchResult = z.infer<typeof researchResultSchema>

/**
 * The AI-checker's verdict shape — used both to validate its JSON reply and,
 * via buildCheckerJsonSchema(), as the structured-output schema handed to
 * whichever provider runs the check.
 */
export const checkerResultSchema = z.object({
  pass: z.boolean(),
  seo_score: z.number().min(0).max(100),
  issues: z.array(z.string()).default([]),
})
export type CheckerResult = z.infer<typeof checkerResultSchema>

export function buildCheckerJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['pass', 'seo_score', 'issues'],
    properties: {
      pass: { type: 'boolean', description: 'True only if the post meets every rule below with no serious issues.' },
      seo_score: {
        type: 'number',
        description: '0-100 rating of SEO quality: title/description length, keyword use, heading structure.',
      },
      issues: { type: 'array', items: { type: 'string' }, description: 'Specific problems found; empty if none.' },
    },
  }
}

export function buildAiPostJsonSchema(categories: string[]): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'title',
      'category',
      'primary_keyword',
      'tags',
      'excerpt',
      'content',
      'seo_title',
      'seo_description',
      'seo_keywords',
    ],
    properties: {
      title: {
        type: 'string',
        description:
          'Compelling, specific, keyword-focused, under 70 characters. MUST contain the primary_keyword. Creates curiosity without being misleading clickbait.',
      },
      slug: { type: 'string', description: 'Lowercase, hyphenated URL slug derived from the title, ideally containing the primary keyword.' },
      category: { type: 'string', enum: categories },
      primary_keyword: {
        type: 'string',
        description: 'The single primary SEO focus keyword/phrase this post targets. Must appear naturally in the title, seo_title, the opening paragraph, and at least one heading.',
      },
      tags: { type: 'array', items: { type: 'string' }, description: '3-6 short lowercase strings.' },
      excerpt: { type: 'string', description: 'A 1-2 sentence summary, under 160 characters.' },
      content: {
        type: 'string',
        description:
          'Valid HTML ready to render directly on the site — no markdown, no code fences, no <html>/<body> wrapper. ' +
          'Heading structure: the page title is the ONLY <h1> (rendered separately, outside this field) — this field must ' +
          'NEVER contain an <h1>. Body headings start at <h2> and nest logically (<h3> only under a preceding <h2>, never skipping levels). ' +
          'Use short paragraphs, bullet/numbered lists where useful, and write for genuine reader value, not keyword stuffing. ' +
          'You may include up to 3 internal links (from the "internal links you may cite" list given in the prompt) and a small ' +
          'number of external links to non-competing, credible sources for facts/citations — as plain <a href="..."> tags inside the text. ' +
          'Never link to any domain on the competitor block-list given in the prompt, under any circumstances. ' +
          'Never include harmful, dangerous, abusive, hateful, illegal, or otherwise inappropriate content.',
      },
      seo_title: {
        type: 'string',
        description: 'Under 60 characters, must contain the primary_keyword, written for strong Google CTR without being misleading.',
      },
      seo_description: { type: 'string', description: 'Under 160 characters, naturally includes the primary_keyword, states the real value of the article.' },
      seo_keywords: { type: 'string', description: 'Comma-separated string: the primary keyword plus relevant secondary/related keywords.' },
    },
  }
}
