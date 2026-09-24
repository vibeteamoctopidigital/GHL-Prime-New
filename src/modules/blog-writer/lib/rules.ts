/**
 * Rules the blog queue is held to, in one place.
 *
 * Both ends need them and they must not drift: the API validates what an
 * editor sends, the printer resolves the same fields for the writer, and the
 * importer resolves them again when a post is saved. If any two disagreed, a
 * topic could be accepted by the form and then rejected by the import that was
 * supposed to fulfil it — a failure nobody would think to look for.
 *
 * Pure: no Prisma, no env, nothing that cannot also be copied into the
 * dashboard's own rules file (ghlprime-updated/src/lib/blogWriterRules.js),
 * which mirrors the numbers here so a button can be disabled before a request
 * is made.
 */

import { CTA_VARIANT_IDS, RANDOM_CTA_VARIANT } from './cta-variants.js'

/** Matches the dashboard's own image limits and scripts/blog-import.ts. */
export const MIN_IMAGES = 0
export const MAX_IMAGES = 6

/**
 * How many posts one run may write.
 *
 * Capped low on purpose. Each post is real research, and the honest
 * experience of running these is that the third is weaker than the first.
 */
export const MIN_PER_RUN = 1
export const MAX_PER_RUN = 3

/**
 * How many posts one schedule may write in a DAY.
 *
 * A different number from MAX_PER_RUN, and a much larger one: a schedule
 * writing ten posts writes them as ten separate runs, each with its own
 * research from nothing, so the tenth is the same work as the first. The
 * ceiling left is about volume — an unattended run that could be set to five
 * hundred is a way to empty a backlog and the usage allowance overnight.
 */
export const MIN_PER_DAY = 1
export const MAX_PER_DAY = 25
export const DEFAULT_PER_DAY = 10

/**
 * Lengths offered in the dashboard. The result is not held to these exactly —
 * see wordRangeFor. 500 is the default deliberately: a short post that says one
 * thing well is a better default than a long one padded to reach a number.
 */
export const WORD_OPTIONS = [500, 1000, 2000] as const
export type WordOption = (typeof WORD_OPTIONS)[number]
export const DEFAULT_WORDS: WordOption = 500

/**
 * The band a post may land in, as a fraction of the length asked for. The
 * chosen number is a midpoint, not a quota: 500 means roughly 400 to 650.
 * Wider above than below on purpose — running long usually means the sources
 * had more to say, running short usually means they had less.
 */
const FLOOR_RATIO = 0.8
const CEILING_RATIO = 1.3

export function wordRangeFor(targetWords: number): { min: number; max: number } {
  return {
    min: Math.round(targetWords * FLOOR_RATIO),
    max: Math.round(targetWords * CEILING_RATIO),
  }
}

/**
 * How much structure a post of this length may carry. Ceilings, never quotas:
 * nothing says a post must contain a list or a table.
 */
export function structureBudgetFor(targetWords: number): { lists: number; tables: number } {
  if (targetWords <= 500) return { lists: 2, tables: 1 }
  if (targetWords <= 1000) return { lists: 3, tables: 2 }
  return { lists: 4, tables: 2 }
}

/** Snap any number to the nearest offered length. */
export function nearestWordOption(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return DEFAULT_WORDS
  return WORD_OPTIONS.reduce<number>(
    (best, option) => (Math.abs(option - n) < Math.abs(best - n) ? option : best),
    DEFAULT_WORDS,
  )
}

/**
 * The categories a post may carry. GHL Prime's blog requires one on every
 * post (BlogPost.category is NOT NULL), so the writer is handed this list and
 * told to pick — the dashboard's blog form offers the same set.
 */
export const BLOG_CATEGORIES = [
  'GoHighLevel',
  'Automation',
  'AI Agents',
  'Case Studies',
  'Voice AI',
  'CRM',
  'Vibe Coding',
] as const

export const DEFAULT_BLOG_CATEGORY = 'GoHighLevel'

/**
 * blog_writer_settings keys. One row each, per that table's key/value design.
 */
export const SETTING_KEYS = {
  postsPerRun: 'blog.queue.postsPerRun',
  imageCount: 'blog.queue.imageCount',
  words: 'blog.queue.words',
  /**
   * Whether a finished post goes live by itself. Off by default, and
   * deliberately not a per-topic override: "does this site publish without a
   * person reading it first" is one decision about the site.
   */
  autoPublish: 'blog.queue.autoPublish',
  /**
   * The batch currently working through the queue, by id. Empty when none is.
   * A batch is a chain of ordinary single-post runs, and this is the switch
   * the watcher consults before queueing each next link — which is what the
   * Stop button clears, so stopping never interrupts a post being written.
   */
  activeBatch: 'blog.queue.activeBatch',
  /**
   * When the run summary was last cleared. The summary lists everything
   * finished since this moment, so closing it is "I have seen these" rather
   * than a deletion.
   */
  summaryClearedAt: 'blog.queue.summaryClearedAt',
  /** Written by the watcher every ~15s; read by the dashboard to show it is alive. */
  writerLastSeen: 'blog.writer.lastSeenAt',
  /** The CTA banner pinned as the default for NEW posts. */
  ctaDefault: 'cta.defaultVariant',
} as const

export type QueueDefaults = {
  postsPerRun: number
  imageCount: number
  words: number
  ctaVariant: string
  autoPublish: boolean
}

export const DEFAULT_QUEUE_DEFAULTS: QueueDefaults = {
  postsPerRun: 1,
  imageCount: 1,
  words: DEFAULT_WORDS,
  ctaVariant: 'general',
  autoPublish: false,
}

/**
 * The phases a run reports, in the order they happen.
 *
 * Derived from the writer's actual tool calls, never from a timer. A phase
 * appearing means the run genuinely reached it, and a run that stalls leaves
 * the card sitting on the step it stalled in.
 */
export const RUN_PHASES = [
  'starting',
  'standard',
  'research',
  'writing',
  'audit',
  'images',
  'saving',
  'done',
] as const

export type RunPhase = (typeof RUN_PHASES)[number]

export const RUN_PHASE_LABELS: Record<RunPhase, string> = {
  starting: 'Starting the writer',
  standard: 'Reading the writing standard',
  research: 'Researching',
  writing: 'Writing the draft',
  audit: 'Auditing against the rules',
  images: 'Fetching images',
  saving: 'Saving to Blog',
  done: 'Finished',
}

export function isRunPhase(value: unknown): value is RunPhase {
  return typeof value === 'string' && (RUN_PHASES as readonly string[]).includes(value)
}

export const TOPIC_KINDS = ['keyword', 'link', 'site'] as const
export type TopicKind = (typeof TOPIC_KINDS)[number]

export const TOPIC_STATUSES = ['queued', 'writing', 'done', 'skipped'] as const
export type TopicStatus = (typeof TOPIC_STATUSES)[number]

export const REQUEST_STATUSES = ['pending', 'running', 'waiting', 'done', 'failed'] as const
export type RequestStatus = (typeof REQUEST_STATUSES)[number]

/**
 * Why a run stopped, when it did. Decides whether it retries itself.
 *
 * `no-post` is the session exiting cleanly with nothing saved — it wound down
 * without ever reaching the importer. Not transient: the same topic tends to
 * end the same way, so it is skipped like any other unusable topic.
 */
export const FAILURE_KINDS = ['limit', 'timeout', 'nothing-to-write', 'no-post', 'error'] as const
export type FailureKind = (typeof FAILURE_KINDS)[number]

/** The kinds that resolve on their own given time, and so retry without anyone asking. */
export const TRANSIENT_FAILURES: readonly FailureKind[] = ['limit', 'timeout']

export function clampImages(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return DEFAULT_QUEUE_DEFAULTS.imageCount
  return Math.min(MAX_IMAGES, Math.max(MIN_IMAGES, Math.round(n)))
}

/**
 * Snap a length to one of the offered options. Snapped rather than clamped
 * because this is a choice from a list, not a range.
 */
export function clampWords(value: unknown): number {
  return nearestWordOption(value)
}

export function clampPerRun(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return DEFAULT_QUEUE_DEFAULTS.postsPerRun
  return Math.min(MAX_PER_RUN, Math.max(MIN_PER_RUN, Math.round(n)))
}

export function clampPerDay(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return DEFAULT_PER_DAY
  return Math.min(MAX_PER_DAY, Math.max(MIN_PER_DAY, Math.round(n)))
}

export function isCtaVariantId(value: unknown): value is string {
  // RANDOM_CTA_VARIANT is storable but is not a banner. It survives as far as
  // the post being written and is resolved there — see resolveCtaVariant.
  return typeof value === 'string' && (value === RANDOM_CTA_VARIANT || CTA_VARIANT_IDS.includes(value))
}

export function isBlogCategory(value: unknown): value is string {
  return typeof value === 'string' && (BLOG_CATEGORIES as readonly string[]).includes(value)
}

/**
 * What kind of topic a line is, from the string alone.
 *
 * A URL with a path is a specific article; a bare host is a site to go looking
 * in; anything that is not a URL is a keyword — including the many strings
 * that merely contain a dot.
 */
export function classifyTopic(topic: string): TopicKind {
  const trimmed = topic.trim()
  if (!trimmed) return 'keyword'

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`

  // A space rules out a host outright.
  if (/\s/.test(trimmed)) return 'keyword'

  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return 'keyword'
  }

  // A hostname with no dot is a word someone typed, not a domain.
  if (!url.hostname.includes('.')) return 'keyword'

  const path = url.pathname.replace(/\/+$/, '')
  return path.length > 0 ? 'link' : 'site'
}

/**
 * The settings a topic actually runs with: its own value wins, anything it
 * leaves unset (null / "") falls back to the queue default.
 */
export function resolveTopicSettings(
  topic: { imageCount?: number | null; words?: number | null; ctaVariant?: string | null },
  defaults: QueueDefaults,
): { imageCount: number; words: number; ctaVariant: string } {
  const imageCount = typeof topic.imageCount === 'number' ? clampImages(topic.imageCount) : defaults.imageCount
  const words = typeof topic.words === 'number' ? clampWords(topic.words) : defaults.words
  const ctaVariant = isCtaVariantId(topic.ctaVariant) ? topic.ctaVariant : defaults.ctaVariant
  return { imageCount, words, ctaVariant }
}

/**
 * How stale the writer's heartbeat may be before the button is pointless.
 *
 * Generous against a 15 second beat: one missed cycle is a slow machine,
 * several is something actually wrong.
 */
export const WRITER_STALE_AFTER_MS = 2 * 60 * 1000

export function isWriterOnline(lastSeen: Date | string | null | undefined): boolean {
  if (!lastSeen) return false
  const at = lastSeen instanceof Date ? lastSeen : new Date(lastSeen)
  if (Number.isNaN(at.getTime())) return false
  return Date.now() - at.getTime() < WRITER_STALE_AFTER_MS
}

/** Reading time the blog list shows, from the body's word count. */
export function readingTimeFor(words: number): number {
  return Math.max(1, Math.round(words / 200))
}
