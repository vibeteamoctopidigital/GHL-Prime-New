/**
 * When the writer should start a post without anyone pressing anything.
 *
 * Kept pure and free of Prisma so the watcher, the API and a test can all ask
 * the same question and get the same answer. Each alarm is a row in
 * blog_run_schedules; only the decision lives here.
 */

/**
 * Where a run takes its topic from: writing what an editor typed, or picking a
 * story out of a publication. Different jobs that suit different hours.
 */
export const RUN_MODES = ['queue', 'sources'] as const
export type RunMode = (typeof RUN_MODES)[number]

export const RUN_MODE_LABELS: Record<RunMode, string> = {
  queue: 'From its keyword list',
  sources: 'From saved sites',
}

export type RunSchedule = {
  enabled: boolean
  mode: RunMode
  /** 24-hour "HH:MM" in `timezone`. */
  time: string
  /** An IANA zone name, e.g. "Asia/Dhaka". */
  timezone: string
}

export const DEFAULT_RUN_SCHEDULE: RunSchedule = {
  enabled: false,
  mode: 'queue',
  time: '07:00',
  timezone: 'Asia/Dhaka',
}

/**
 * One keyword waiting its turn, and how its post should be set up.
 *
 * The three overrides follow the queue's convention: null and "" mean
 * "whatever the schedule says", so a row moved in from the queue arrives
 * intact and one that never overrode anything picks up the schedule's own.
 */
export type ScheduleKeyword = {
  topic: string
  notes: string
  imageCount: number | null
  words: number | null
  ctaVariant: string
}

/** What the last scan made of a site. Null until the schedule has run once. */
export type ScheduleSiteScan = {
  at: string
  /** Headlines read off the site. */
  found: number
  /** Of those, how many the picker was shown (after de-duplication and the fair-share cap). */
  shown: number
  /** How many of the shown were chosen. */
  picked: number
  /** "feed", "scrape" or "none". */
  via: string
  /** Why nothing was read, when nothing was. */
  error: string
}

export type ScheduleSite = {
  url: string
  notes: string
  enabled: boolean
  lastUsedAt: string | null
  lastScan: ScheduleSiteScan | null
}

/**
 * One stored alarm, as both the watcher and the dashboard see it. Declared
 * once so the two readers cannot drift.
 */
export type ScheduleRow = RunSchedule & {
  id: string
  name: string
  postsPerRun: number
  /** Posts a day. Separate from postsPerRun because they measure different things. */
  postsPerDay: number
  /** How many keywords the schedule is holding. `keywords` is only the first page. */
  keywordCount: number
  sheetUrl: string
  imageCount: number
  words: number
  ctaVariant: string
  /** The first page only, for the card to show without a second request. */
  keywords: ScheduleKeyword[]
  sites: ScheduleSite[]
  lastRunDay: string
}

/**
 * How many keywords one schedule may hold. A content calendar is hundreds of
 * rows; two thousand is past any list a person assembled by hand.
 */
export const MAX_SCHEDULE_KEYWORDS = 2000

/**
 * How many sites one schedule may hold. A hundred publications is already more
 * than a schedule could reach in a quarter.
 */
export const MAX_SCHEDULE_SITES = 100

/** Keywords per page, shared by the list payload and the paged endpoint. */
export const SCHEDULE_KEYWORD_PAGE = 25

/**
 * The stored site list as the dashboard, the API and the watcher all read it.
 * One reader so "null" means the same thing everywhere.
 */
export function readSites(raw: unknown): ScheduleSite[] {
  if (!Array.isArray(raw)) return []
  const out: ScheduleSite[] = []
  for (const entry of raw) {
    const row = (entry ?? {}) as Record<string, unknown>
    const url = typeof row['url'] === 'string' ? row['url'].trim() : ''
    if (!url) continue
    out.push({
      url,
      notes: typeof row['notes'] === 'string' ? row['notes'] : '',
      enabled: row['enabled'] !== false,
      lastUsedAt: typeof row['lastUsedAt'] === 'string' ? row['lastUsedAt'] : null,
      lastScan: readSiteScan(row['lastScan']),
    })
  }
  return out
}

export function readSiteScan(raw: unknown): ScheduleSiteScan | null {
  if (!raw || typeof raw !== 'object') return null
  const scan = raw as Record<string, unknown>
  if (typeof scan['at'] !== 'string' || !scan['at']) return null
  const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  return {
    at: scan['at'],
    found: num(scan['found']),
    shown: num(scan['shown']),
    picked: num(scan['picked']),
    via: typeof scan['via'] === 'string' ? scan['via'] : '',
    error: typeof scan['error'] === 'string' ? scan['error'] : '',
  }
}

/**
 * How long a backlog lasts at a given rate, in words worth reading. "finishes
 * 27 Nov" is the half that gets acted on.
 */
export function projectFinish(queued: number, perDay: number): string {
  if (queued === 0) return 'nothing waiting'
  if (perDay < 1) return `${queued} waiting`

  const days = Math.ceil(queued / perDay)
  const finish = new Date()
  finish.setDate(finish.getDate() + days - 1)

  const when = finish.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: finish.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  })

  if (days === 1) return `${queued} waiting · all of it today`
  return `${queued} waiting · ${perDay} a day · ${days} days · finishes ${when}`
}

/**
 * Turn typed text into keywords.
 *
 * Newlines always separate; commas only when asked — "shopify vs woocommerce,
 * which is better" is one keyword and "seo, ppc, cro" is three, and nothing in
 * the text says which. Notes are read off (after a `|`) before any comma
 * splitting, so "seo, ppc | UK market" gives two keywords that both carry the
 * note.
 */
export function parseKeywordText(text: string, splitCommas: boolean): ScheduleKeyword[] {
  const out: ScheduleKeyword[] = []

  for (const line of text.split('\n')) {
    const cleaned = line.trim().replace(/^[-*•]\s*/, '')
    if (!cleaned) continue

    const [topicPart = '', ...rest] = cleaned.split('|')
    const notes = rest.join('|').trim()

    const topics = splitCommas ? topicPart.split(',') : [topicPart]

    for (const topic of topics) {
      const trimmed = topic.trim()
      if (!trimmed) continue
      out.push({ topic: trimmed, notes, imageCount: null, words: null, ctaVariant: '' })
    }
  }

  return out
}

export function isRunMode(value: unknown): value is RunMode {
  return typeof value === 'string' && (RUN_MODES as readonly string[]).includes(value)
}

/**
 * How late a missed run may still go ahead. A machine asleep at seven should
 * still write the morning's post at nine; one back at midnight should not.
 */
export const CATCH_UP_MS = 6 * 60 * 60 * 1000

/** "07:30" → 450. Anything unparseable falls back to the default hour. */
export function minutesFromTime(time: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim())
  if (!match) return 7 * 60

  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return 7 * 60

  return hours * 60 + minutes
}

export function isValidTime(time: unknown): time is string {
  if (typeof time !== 'string') return false
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim())
  return Boolean(match) && Number(match![1]) <= 23 && Number(match![2]) <= 59
}

/**
 * Whether a zone name is one this runtime actually knows. Checked rather than
 * trusted because an unknown zone makes every later calculation throw.
 */
export function isValidTimezone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || !zone.trim()) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/** The wall clock in a given zone: the calendar day, and minutes since midnight. */
export function wallClock(at: Date, timezone: string): { day: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at)

  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '00'
  // 24 rather than 00 is how some zones render midnight.
  const hour = get('hour') === '24' ? 0 : Number(get('hour'))

  return {
    day: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: hour * 60 + Number(get('minute')),
  }
}

export type DueState =
  | { action: 'wait'; day: string }
  | { action: 'run'; day: string }
  | { action: 'skip'; day: string; reason: string }

/**
 * Decide what the scheduler should do right now. `lastRunDay` is what the
 * caller has stored; the returned `day` is what it should store once it has
 * acted, which keeps a run to one a day however often this is called.
 */
export function dueState(schedule: RunSchedule, lastRunDay: string, now: Date = new Date()): DueState {
  const timezone = isValidTimezone(schedule.timezone) ? schedule.timezone : DEFAULT_RUN_SCHEDULE.timezone

  const { day, minutes } = wallClock(now, timezone)

  if (!schedule.enabled) return { action: 'wait', day }
  if (lastRunDay === day) return { action: 'wait', day }

  const due = minutesFromTime(schedule.time)
  if (minutes < due) return { action: 'wait', day }

  const lateBy = (minutes - due) * 60 * 1000
  if (lateBy > CATCH_UP_MS) {
    return {
      action: 'skip',
      day,
      reason: `${Math.round(lateBy / 3_600_000)}h past ${schedule.time}; waiting for tomorrow`,
    }
  }

  return { action: 'run', day }
}

/** One line for the dashboard and the watcher's startup banner. */
export function describeSchedule(schedule: RunSchedule & { name?: string }): string {
  const what = RUN_MODE_LABELS[schedule.mode].toLowerCase()
  const when = `${schedule.time} ${schedule.timezone}`
  return schedule.enabled ? `daily at ${when}, ${what}` : 'paused'
}
