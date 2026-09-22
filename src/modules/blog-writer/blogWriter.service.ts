import type { Prisma } from '@prisma/client'
import prisma from '../../config/prisma.js'
import ApiError from '../../shared/utils/ApiError.js'
import logger from '../../shared/utils/logger.js'
import {
  appendKeywords,
  getActiveBatch,
  getQueueDefaults,
  getSettings,
  getWriterLastSeen,
  keywordSelect,
  listSchedules,
  nextTopicOrder,
  serializeKeyword,
  setActiveBatch,
  setQueueDefaults,
  setSetting,
} from './blogWriter.store.js'
import {
  DEFAULT_WORDS,
  SETTING_KEYS,
  TOPIC_STATUSES,
  classifyTopic,
  clampImages,
  clampPerDay,
  clampPerRun,
  clampWords,
  isCtaVariantId,
  isWriterOnline,
  type QueueDefaults,
} from './lib/rules.js'
import {
  DEFAULT_RUN_SCHEDULE,
  MAX_SCHEDULE_KEYWORDS,
  MAX_SCHEDULE_SITES,
  SCHEDULE_KEYWORD_PAGE,
  isRunMode,
  isValidTime,
  isValidTimezone,
  parseKeywordText,
  readSiteScan,
  readSites,
  type ScheduleKeyword,
  type ScheduleSite,
} from './lib/run-schedule.js'
import { looksLikeArticleUrl } from './lib/headlines.js'
import { parseSheetUrl, readCalendar, sheetCsvUrl } from './lib/sheet-import.js'
import type { z } from 'zod'
import type {
  addKeywordsSchema,
  bulkTopicsSchema,
  createScheduleSchema,
  createTopicSchema,
  defaultsSchema,
  importSheetSchema,
  keywordPageQuerySchema,
  reorderSchema,
  requestWriteSchema,
  transferSchema,
  updateScheduleSchema,
  updateTopicSchema,
} from './blogWriter.validators.js'

/**
 * The AI Blog Writer's queue, batches and schedules — the server half.
 *
 * Every function here records an ask or reads state. None of them write a
 * post: generation runs in a Claude Code session on the watcher's machine,
 * and the dashboard has no way to produce a post on its own, which is the
 * whole reason this indirection exists.
 *
 * Ported route by route from octopi's app/api/dashboard/blog-queue/*, onto
 * Prisma. Where octopi returned `{ error }` with a status, this throws an
 * ApiError with the same status and message.
 */

/**
 * How many queued topics one response carries. The queue is worked from the
 * front, in order, so what is on screen is the next few dozen; the totals are
 * counted separately and sent alongside.
 */
const QUEUE_PAGE = 60

/** Finished topics kept in the run summary. Newest first. */
const SUMMARY_PAGE = 60

/** Anything more than this in one paste is a mistake, not a plan. */
const MAX_BULK_TOPICS = 1000

/** Past this, a sheet is not a content calendar and something has gone wrong. */
const MAX_SHEET_ROWS = 2000

/** A slow sheet should fail as a message, not as a hung request. */
const SHEET_FETCH_TIMEOUT_MS = 30_000

const ACTIVE_STATUSES = ['pending', 'running', 'waiting'] as const

type Usage = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUsd: number
  turns: number
  durationMs: number
  models: string[]
}

function readUsage(raw: unknown): Usage | null {
  if (!raw || typeof raw !== 'object') return null
  const usage = raw as Record<string, unknown>
  const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  return {
    inputTokens: num(usage['inputTokens']),
    outputTokens: num(usage['outputTokens']),
    cacheReadTokens: num(usage['cacheReadTokens']),
    cacheCreationTokens: num(usage['cacheCreationTokens']),
    costUsd: num(usage['costUsd']),
    turns: num(usage['turns']),
    durationMs: num(usage['durationMs']),
    models: Array.isArray(usage['models']) ? usage['models'].filter((m): m is string => typeof m === 'string') : [],
  }
}

function readSteps(raw: unknown): { phase: string; detail: string; at: string | null }[] {
  if (!Array.isArray(raw)) return []
  return raw.map((entry) => {
    const step = (entry ?? {}) as Record<string, unknown>
    return {
      phase: typeof step['phase'] === 'string' ? step['phase'] : 'starting',
      detail: typeof step['detail'] === 'string' ? step['detail'] : '',
      at: typeof step['at'] === 'string' ? step['at'] : null,
    }
  })
}

const iso = (date: Date | null | undefined): string | null => date?.toISOString() ?? null

/* -------------------------------------------------------------------------- */
/* The screen payload                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Everything the writer screen needs in one call: the queue, the defaults,
 * whether the writer is actually listening, the run in flight, the last few
 * finished runs, the batch being shown, and the run summary.
 */
async function getState() {
  const [topics, defaults, schedules, lastSeen, activeRequest, recentRuns, settingRows, finishedRows, queuedTotal, overridingTotal, scheduledTotal] =
    await Promise.all([
      prisma.blogTopic.findMany({
        where: { status: 'queued' },
        orderBy: [{ order: 'asc' }, { created_at: 'asc' }],
        take: QUEUE_PAGE,
      }),
      getQueueDefaults(),
      listSchedules(),
      getWriterLastSeen(),
      // A waiting run is still the active one: paused on a usage limit with a
      // time to resume, and the card should keep showing it.
      prisma.blogWriteRequest.findFirst({ where: { status: { in: [...ACTIVE_STATUSES] } }, orderBy: { created_at: 'asc' } }),
      prisma.blogWriteRequest.findMany({ where: { status: { in: ['done', 'failed'] } }, orderBy: { created_at: 'desc' }, take: 5 }),
      getSettings([SETTING_KEYS.activeBatch, SETTING_KEYS.summaryClearedAt]),
      prisma.blogTopic.findMany({ where: { status: { in: ['done', 'skipped'] } }, orderBy: { updated_at: 'desc' }, take: SUMMARY_PAGE }),
      prisma.blogTopic.count({ where: { status: 'queued' } }),
      // Counted rather than derived from the page above — the row that
      // overrides a default is as likely to be the four hundredth as the fourth.
      prisma.blogTopic.count({
        where: { status: 'queued', OR: [{ image_count: { not: null } }, { words: { not: null } }, { cta_variant: { not: '' } }] },
      }),
      // Queued rows a schedule owns. While there are any, the queue is not
      // something to offer for transfer: they came from a schedule already.
      prisma.blogTopic.count({ where: { status: 'queued', schedule_id: { not: null } } }),
    ])

  const activeBatch = settingRows.get(SETTING_KEYS.activeBatch) ?? ''
  const summaryClearedAt = settingRows.get(SETTING_KEYS.summaryClearedAt) ?? ''

  // The batch to show: the one running, or failing that the last one there
  // was — a schedule's day ends by itself, usually while nobody is watching.
  const shownBatch =
    activeBatch ||
    ((await prisma.blogWriteRequest.findFirst({ where: { batch_id: { not: '' } }, orderBy: { created_at: 'desc' }, select: { batch_id: true } }))
      ?.batch_id ??
      '')

  const [batchRequests, batchQueued] = shownBatch
    ? await Promise.all([
        prisma.blogWriteRequest.findMany({ where: { batch_id: shownBatch }, orderBy: { created_at: 'asc' } }),
        // Only a scheduled batch tags its rows up front, so for a manual batch
        // this is empty and the block shows what has run.
        prisma.blogTopic.findMany({ where: { batch_id: shownBatch, status: 'queued' }, orderBy: { order: 'asc' } }),
      ])
    : [[], []]

  // How many the batch set out to write, read off the request rather than
  // recounted — the queue shrinks as it goes.
  const batchTotal = batchRequests[0]?.batch_total ?? 0

  // Whether each finished topic's post went live or is waiting as a draft:
  // read off the post, because the auto-publish setting is what was asked for
  // and this is what happened.
  const slugs = [...topics, ...finishedRows, ...batchRequests].map((entry) => entry.blog_slug).filter(Boolean)
  const posts = slugs.length
    ? await prisma.blogPost.findMany({ where: { slug: { in: slugs } }, select: { slug: true, published: true } })
    : []
  const postStatus = new Map(posts.map((post) => [post.slug, post.published ? 'published' : 'draft']))

  // How much has finished since the summary was last closed — counted, not
  // read off the capped page above.
  const clearedAt = summaryClearedAt ? new Date(summaryClearedAt) : null
  const finishedSinceClear = await prisma.blogTopic.count({
    where: { status: { in: ['done', 'skipped'] }, ...(clearedAt ? { updated_at: { gt: clearedAt } } : {}) },
  })

  const row = (topic: (typeof topics)[number]) => ({
    id: topic.id,
    topic: topic.topic,
    kind: topic.kind,
    notes: topic.notes,
    imageCount: topic.image_count,
    words: topic.words,
    ctaVariant: topic.cta_variant,
    status: topic.status,
    order: topic.order,
    blogSlug: topic.blog_slug,
    writtenAt: iso(topic.written_at),
    // When this topic stopped being queued, for deciding whether the summary
    // has already been closed on it. Falls back to updated_at because
    // written_at is only set by the importer.
    finishedAt: iso(topic.written_at) ?? iso(topic.updated_at),
    skipReason: topic.skip_reason,
    batchId: topic.batch_id,
    scheduleName: topic.schedule_name,
    postStatus: topic.blog_slug ? (postStatus.get(topic.blog_slug) ?? '') : '',
  })

  // One line per post in the batch, in the order they happen: finished and
  // failed runs first, then whatever is running or waiting, then (for a
  // scheduled batch) the rows still to come.
  const batchRunRows = batchRequests.map((request) => ({
    id: request.id,
    status: request.status,
    topic: request.topic_label,
    blogSlug: request.blog_slug,
    postStatus: request.blog_slug ? (postStatus.get(request.blog_slug) ?? '') : '',
    detail: request.detail,
    failureKind: request.failure_kind ?? '',
    retryAfter: iso(request.retry_after),
    finishedAt: iso(request.finished_at),
    usage: readUsage(request.usage),
  }))

  const batchQueuedRows = batchQueued.map((topic) => ({
    id: topic.id,
    status: 'queued' as const,
    topic: topic.topic,
    blogSlug: '',
    postStatus: '',
    detail: '',
    failureKind: '',
    retryAfter: null,
    finishedAt: null,
    usage: null,
  }))

  const batchScheduleName =
    batchQueued[0]?.schedule_name ||
    (batchRequests[0]?.requested_by.startsWith('schedule:') ? batchRequests[0].requested_by.slice('schedule:'.length) : '')

  return {
    topics: topics.map(row),
    finished: finishedRows.map(row),
    defaults,
    schedules: schedules.map((schedule) => ({
      id: schedule.id,
      name: schedule.name,
      enabled: schedule.enabled,
      mode: schedule.mode,
      time: schedule.time,
      timezone: schedule.timezone,
      postsPerDay: schedule.postsPerDay,
    })),
    writer: { lastSeen: iso(lastSeen), online: isWriterOnline(lastSeen) },
    activeRequest: activeRequest
      ? {
          id: activeRequest.id,
          status: activeRequest.status,
          phase: activeRequest.phase,
          detail: activeRequest.detail,
          steps: readSteps(activeRequest.steps),
          requestedBy: activeRequest.requested_by,
          topicLabel: activeRequest.topic_label,
          failureKind: activeRequest.failure_kind ?? '',
          attempts: activeRequest.attempts,
          retryAfter: iso(activeRequest.retry_after),
          startedAt: iso(activeRequest.started_at),
          createdAt: iso(activeRequest.created_at),
        }
      : null,
    batch: {
      id: activeBatch,
      total: batchTotal,
      shownId: shownBatch,
      scheduleName: batchScheduleName,
      // Which schedule it belongs to, read off the id a schedule mints
      // ("schedule-<uuid>-<time>").
      scheduleId: shownBatch.match(/^schedule-([0-9a-f-]{36})-/)?.[1] ?? '',
      startedAt: iso(batchRequests[0]?.created_at),
      rows: [...batchRunRows, ...batchQueuedRows],
    },
    counts: { queued: queuedTotal, overriding: overridingTotal, scheduled: scheduledTotal },
    summary: { clearedAt: summaryClearedAt, closeable: true, finished: finishedSinceClear },
    recentRuns: recentRuns.map((run) => ({
      id: run.id,
      status: run.status,
      blogSlug: run.blog_slug,
      topicLabel: run.topic_label,
      topicId: run.topic_id ?? '',
      failureKind: run.failure_kind ?? '',
      attempts: run.attempts,
      error: run.error,
      requestedBy: run.requested_by,
      finishedAt: iso(run.finished_at),
      usage: readUsage(run.usage),
    })),
  }
}

/* -------------------------------------------------------------------------- */
/* Topics                                                                     */
/* -------------------------------------------------------------------------- */

/** Add a topic. It lands at the end of the queue. */
async function createTopic(input: z.infer<typeof createTopicSchema>) {
  const ctaVariant = input.ctaVariant ?? ''
  if (ctaVariant && !isCtaVariantId(ctaVariant)) throw ApiError.badRequest(`Unknown CTA banner "${ctaVariant}".`)

  // Not a unique index: a topic legitimately comes back after being written.
  const duplicate = await prisma.blogTopic.findFirst({ where: { topic: input.topic, status: 'queued' } })
  if (duplicate) throw ApiError.conflict('That topic is already queued.')

  const created = await prisma.blogTopic.create({
    data: {
      topic: input.topic,
      kind: classifyTopic(input.topic),
      notes: input.notes ?? '',
      image_count: typeof input.imageCount === 'number' ? clampImages(input.imageCount) : null,
      words: typeof input.words === 'number' ? clampWords(input.words) : null,
      cta_variant: ctaVariant,
      order: await nextTopicOrder(),
    },
  })

  return { id: created.id }
}

/**
 * Add many topics at once, from a pasted list. Reports what was skipped
 * rather than failing the batch.
 */
async function bulkAddTopics(input: z.infer<typeof bulkTopicsSchema>) {
  const seen = new Set<string>()
  const wanted: string[] = []
  for (const entry of input.topics) {
    if (typeof entry !== 'string') continue
    for (const part of entry.split(/[\n,]+/)) {
      const topic = part.trim().replace(/^[-*•]\s*/, '')
      if (!topic) continue
      const key = topic.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      wanted.push(topic)
    }
  }

  if (wanted.length === 0) throw ApiError.badRequest('Nothing to add.')
  if (wanted.length > MAX_BULK_TOPICS) {
    throw ApiError.badRequest(`That is ${wanted.length} topics. Add at most ${MAX_BULK_TOPICS} at a time.`)
  }

  const existing = await prisma.blogTopic.findMany({ where: { status: 'queued' }, select: { topic: true } })
  const queued = new Set(existing.map((row) => row.topic.trim().toLowerCase()))

  const fresh = wanted.filter((topic) => !queued.has(topic.toLowerCase()))
  const duplicates = wanted.length - fresh.length

  let order = await nextTopicOrder()
  const rows = fresh.map((topic) => ({ topic, kind: classifyTopic(topic), order: (order += 10) }))

  if (rows.length > 0) await prisma.blogTopic.createMany({ data: rows })

  return { added: rows.length, duplicates }
}

/** Edit one topic. Only what is sent gets written. */
async function updateTopic(id: string, input: z.infer<typeof updateTopicSchema>) {
  const update: Prisma.BlogTopicUpdateInput = {}

  if (typeof input.topic === 'string') {
    if (!input.topic) throw ApiError.badRequest('A topic is required.')
    update.topic = input.topic
    // Re-derived rather than trusted from the client.
    update.kind = classifyTopic(input.topic)
  }

  if (typeof input.notes === 'string') update.notes = input.notes

  // Null is meaningful — it clears the override and returns the row to the
  // queue default, which is different from setting it to zero images.
  if (input.imageCount === null) update.image_count = null
  else if (typeof input.imageCount === 'number') update.image_count = clampImages(input.imageCount)

  if (input.words === null) update.words = null
  else if (typeof input.words === 'number') update.words = clampWords(input.words)

  if (typeof input.ctaVariant === 'string') {
    if (input.ctaVariant && !isCtaVariantId(input.ctaVariant)) throw ApiError.badRequest(`Unknown CTA banner "${input.ctaVariant}".`)
    update.cta_variant = input.ctaVariant
  }

  if (typeof input.status === 'string') {
    if (!(TOPIC_STATUSES as readonly string[]).includes(input.status)) throw ApiError.badRequest(`Unknown status "${input.status}".`)
    update.status = input.status
    // Clearing the reason on re-queue stops a stale explanation following a topic back.
    if (input.status !== 'skipped') update.skip_reason = ''
  }

  if (typeof input.skipReason === 'string') update.skip_reason = input.skipReason

  if (Object.keys(update).length === 0) throw ApiError.badRequest('Nothing to update.')

  const result = await prisma.blogTopic.updateMany({ where: { id }, data: update })
  if (result.count === 0) throw ApiError.notFound('Topic not found.')

  return { ok: true }
}

/** Remove a topic. A hard delete; the post it produced survives on its own. */
async function deleteTopic(id: string) {
  const result = await prisma.blogTopic.deleteMany({ where: { id } })
  if (result.count === 0) throw ApiError.notFound('Topic not found.')
  return { ok: true }
}

/** Set the queue order from a list of ids. Positions are rewritten in steps of ten. */
async function reorderTopics(input: z.infer<typeof reorderSchema>) {
  await prisma.$transaction(
    input.ids.map((id, index) => prisma.blogTopic.updateMany({ where: { id }, data: { order: (index + 1) * 10 } })),
  )
  return { ok: true }
}

/* -------------------------------------------------------------------------- */
/* Defaults                                                                   */
/* -------------------------------------------------------------------------- */

async function getDefaults() {
  return { defaults: await getQueueDefaults() }
}

/**
 * Save the defaults. Counts are clamped; an unknown CTA id is rejected
 * because it means the catalogue moved under the editor.
 */
async function saveDefaults(input: z.infer<typeof defaultsSchema>) {
  if (!isCtaVariantId(input.ctaVariant)) throw ApiError.badRequest('Pick a CTA banner from the list.')

  const defaults: QueueDefaults = {
    postsPerRun: clampPerRun(input.postsPerRun),
    imageCount: clampImages(input.imageCount),
    words: clampWords(input.words),
    ctaVariant: input.ctaVariant,
    // Strict true rather than truthy: this decides whether writing reaches
    // readers unread.
    autoPublish: input.autoPublish === true,
  }

  await setQueueDefaults(defaults)
  return { defaults }
}

/**
 * Make every queued topic follow the defaults — by CLEARING the per-topic
 * values, not copying the current ones in. A topic with no value of its own
 * reads the default at the moment it is written, so it also picks up later
 * changes. Only queued topics: a written one records what it was written with.
 */
async function applyDefaults() {
  const result = await prisma.blogTopic.updateMany({
    where: { status: 'queued', OR: [{ image_count: { not: null } }, { words: { not: null } }, { cta_variant: { not: '' } }] },
    data: { image_count: null, words: null, cta_variant: '' },
  })
  return { updated: result.count }
}

/* -------------------------------------------------------------------------- */
/* Sheet import                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Fill the queue, or one schedule's keyword list, from a Google Sheets content
 * calendar. Rows the calendar marks done never arrive; rows already known are
 * filtered; so re-running after the sheet grows adds the new rows and nothing else.
 */
async function importSheet(input: z.infer<typeof importSheetSchema>) {
  const ref = parseSheetUrl(input.url)
  if (!ref) throw ApiError.badRequest('That does not look like a Google Sheets link.')

  let csv: string
  try {
    const res = await fetch(sheetCsvUrl(ref), { redirect: 'follow', signal: AbortSignal.timeout(SHEET_FETCH_TIMEOUT_MS) })
    if (!res.ok) {
      throw ApiError.badRequest(`Google refused that sheet (${res.status}). Is it shared with anyone who has the link?`)
    }
    csv = await res.text()
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw ApiError.badGateway('Could not reach that sheet.')
  }

  // Google answers a private sheet with a sign-in page rather than an error.
  if (csv.trimStart().startsWith('<')) {
    throw ApiError.badRequest('That sheet is not readable without signing in. Set it to “Anyone with the link can view”, then try again.')
  }

  const { topics, done, blank, headers } = readCalendar(csv)

  if (topics.length === 0 && done === 0) {
    throw ApiError.badRequest(
      headers.length
        ? `That tab has no keyword or title column. It starts with: ${headers.slice(0, 6).join(', ')}. Open the content calendar tab and copy its URL.`
        : 'That tab is empty.',
    )
  }

  if (topics.length > MAX_SHEET_ROWS) {
    throw ApiError.badRequest(`That tab has ${topics.length} rows to queue, more than the ${MAX_SHEET_ROWS} limit.`)
  }

  const scheduleId = input.scheduleId ?? ''
  const schedule = scheduleId
    ? await prisma.blogRunSchedule.findUnique({
        where: { id: scheduleId },
        include: { keywords: { select: { topic: true } } },
      })
    : null
  if (scheduleId && !schedule) throw ApiError.notFound('That schedule no longer exists.')

  // Compared against everything the queue has ever held, not only what is
  // waiting: a keyword already written is already written.
  const existing = await prisma.blogTopic.findMany({ select: { topic: true } })
  const seen = new Set(existing.map((row) => row.topic.trim().toLowerCase()))
  for (const keyword of schedule?.keywords ?? []) seen.add(keyword.topic.trim().toLowerCase())

  const fresh: typeof topics = []
  for (const topic of topics) {
    const key = topic.topic.trim().toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    fresh.push(topic)
  }

  const duplicates = topics.length - fresh.length

  if (schedule) {
    const room = Math.max(0, MAX_SCHEDULE_KEYWORDS - schedule.keywords.length)
    const taking = fresh.slice(0, room)
    await appendKeywords(
      schedule.id,
      taking.map((entry) => ({ topic: entry.topic, notes: entry.notes, imageCount: null, words: null, ctaVariant: '' })),
    )
    return { added: taking.length, duplicates, done, blank, total: topics.length + done, overflowed: fresh.length - taking.length }
  }

  let order = await nextTopicOrder()
  const rows = fresh.map((entry) => ({ topic: entry.topic, kind: classifyTopic(entry.topic), notes: entry.notes, order: (order += 10) }))
  if (rows.length > 0) await prisma.blogTopic.createMany({ data: rows })

  return { added: rows.length, duplicates, done, blank, total: topics.length + done, overflowed: 0 }
}

/* -------------------------------------------------------------------------- */
/* Requests, batches, summary                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Ask for the next post to be written. Records the request; the watcher does
 * the writing. Refused when nothing is listening, and while a request is
 * already in flight (a paused one counts).
 */
async function requestWrite(input: z.infer<typeof requestWriteSchema>, requestedBy: string) {
  const lastSeen = await getWriterLastSeen()
  if (!isWriterOnline(lastSeen)) {
    throw new ApiError(409, 'The writer is offline, so nothing would pick this up. Start it on the machine that runs Claude Code and try again.', {
      details: { lastSeen: iso(lastSeen) },
    })
  }

  const existing = await prisma.blogWriteRequest.findFirst({ where: { status: { in: [...ACTIVE_STATUSES] } } })
  if (existing) {
    throw new ApiError(
      409,
      existing.status === 'waiting' ? 'A post is paused on the usage limit and will continue by itself.' : 'A post is already being written.',
      { details: { id: existing.id, status: existing.status } },
    )
  }

  const topicId = input.topicId ?? null
  const all = input.all === true

  if (topicId) {
    const topic = await prisma.blogTopic.findFirst({ where: { id: topicId, status: 'queued' } })
    if (!topic) throw ApiError.notFound('That topic is not in the queue.')
  } else {
    const next = await prisma.blogTopic.findFirst({ where: { status: 'queued' }, orderBy: { order: 'asc' } })
    if (!next) throw ApiError.badRequest('The queue is empty.')
  }

  // A batch is started by recording its id, not by queueing fifty requests:
  // only ONE request exists at a time either way, and the watcher queues the
  // next topic under the same id when it finishes.
  let batchId = ''
  let batchTotal = 0

  if (all) {
    batchTotal = await prisma.blogTopic.count({ where: { status: 'queued' } })
    batchId = `batch-${Date.now()}`
    await setActiveBatch(batchId)
  }

  const created = await prisma.blogWriteRequest.create({
    data: { topic_id: topicId, requested_by: requestedBy, batch_id: batchId, batch_total: batchTotal },
  })

  return { id: created.id, status: 'pending', batchId, batchTotal }
}

/**
 * Stop the batch working through the queue. Clearing the switch is the whole
 * of it: whatever is being written now finishes; nothing after it is started.
 */
async function stopBatch() {
  await setActiveBatch('')
  return { ok: true }
}

/** Close the run summary: records the moment rather than deleting anything. */
async function closeSummary() {
  await setSetting(SETTING_KEYS.summaryClearedAt, new Date().toISOString())
  return { ok: true }
}

/** Dismiss a finished run from the recent list. A run in flight is refused. */
async function dismissRun(id: string) {
  const result = await prisma.blogWriteRequest.deleteMany({ where: { id, status: { in: ['done', 'failed'] } } })
  if (result.count === 0) throw ApiError.conflict('That run is still going, or is already gone.')
  return { ok: true }
}

/**
 * Try a failed run again. The same row is reused; `attempts` is reset because
 * someone choosing to retry is saying the circumstances changed. The topic goes
 * back to `queued` first, in its original position.
 */
async function retryRun(id: string) {
  const run = await prisma.blogWriteRequest.findFirst({ where: { id, status: 'failed' }, select: { topic_id: true, steps: true } })
  if (!run) throw ApiError.notFound('That run is not one that can be retried.')

  await prisma.$transaction(async (tx) => {
    if (run.topic_id) {
      await tx.blogTopic.updateMany({ where: { id: run.topic_id, status: 'skipped' }, data: { status: 'queued', skip_reason: '' } })
    }

    const steps = readSteps(run.steps)
    steps.push({ phase: 'starting', detail: 'retried by hand', at: new Date().toISOString() })

    await tx.blogWriteRequest.update({
      where: { id },
      data: {
        status: 'pending',
        phase: 'starting',
        detail: 'queued again',
        error: '',
        attempts: 0,
        retry_after: null,
        started_at: null,
        finished_at: null,
        failure_kind: null,
        steps,
      },
    })
  })

  return { ok: true }
}

/* -------------------------------------------------------------------------- */
/* Schedules                                                                  */
/* -------------------------------------------------------------------------- */

async function getSchedules() {
  return { schedules: await listSchedules() }
}

/**
 * Add a schedule. Created switched off, empty, and on the defaults unless the
 * payload says otherwise (the writer screen's transfer button does).
 */
async function createSchedule(input: z.infer<typeof createScheduleSchema>) {
  if (input.time !== undefined && !isValidTime(input.time)) throw ApiError.badRequest('Time must look like 07:00.')
  if (input.timezone !== undefined && !isValidTimezone(input.timezone)) {
    throw ApiError.badRequest('That is not a timezone this server knows, e.g. Asia/Dhaka.')
  }
  if (input.mode !== undefined && !isRunMode(input.mode)) throw ApiError.badRequest('Unknown mode.')

  const last = await prisma.blogRunSchedule.findFirst({ orderBy: { order: 'desc' }, select: { order: true } })

  const created = await prisma.blogRunSchedule.create({
    data: {
      name: input.name || 'New schedule',
      enabled: input.enabled === true,
      mode: isRunMode(input.mode) ? input.mode : DEFAULT_RUN_SCHEDULE.mode,
      time: isValidTime(input.time) ? input.time.trim() : DEFAULT_RUN_SCHEDULE.time,
      timezone: isValidTimezone(input.timezone) ? input.timezone.trim() : DEFAULT_RUN_SCHEDULE.timezone,
      posts_per_run: 1,
      posts_per_day: clampPerDay(input.postsPerDay),
      image_count: 1,
      words: DEFAULT_WORDS,
      sites: [],
      order: (last?.order ?? 0) + 10,
    },
  })

  return { id: created.id }
}

/**
 * Edit one schedule. Time and timezone are rejected rather than corrected:
 * falling back to a default the editor never chose would show as a run at
 * the wrong hour, and not until the next morning.
 */
async function updateSchedule(id: string, input: z.infer<typeof updateScheduleSchema>) {
  const update: Prisma.BlogRunScheduleUpdateInput = {}

  if (typeof input.name === 'string') update.name = input.name.trim() || 'Schedule'
  if (typeof input.enabled === 'boolean') update.enabled = input.enabled
  if (input.postsPerRun !== undefined) update.posts_per_run = clampPerRun(input.postsPerRun)
  if (input.postsPerDay !== undefined) update.posts_per_day = clampPerDay(input.postsPerDay)
  if (input.imageCount !== undefined) update.image_count = clampImages(input.imageCount)
  if (input.words !== undefined) update.words = clampWords(input.words)

  if (input.ctaVariant !== undefined) {
    if (input.ctaVariant !== '' && !isCtaVariantId(input.ctaVariant)) throw ApiError.badRequest('Unknown CTA banner.')
    update.cta_variant = input.ctaVariant as string
  }

  if (input.sheetUrl !== undefined) {
    const sheetUrl = typeof input.sheetUrl === 'string' ? input.sheetUrl.trim() : ''
    if (sheetUrl && !parseSheetUrl(sheetUrl)) throw ApiError.badRequest('That does not look like a Google Sheets link.')
    update.sheet_url = sheetUrl
  }

  if (input.mode !== undefined) {
    if (!isRunMode(input.mode)) throw ApiError.badRequest('Unknown mode.')
    update.mode = input.mode
  }

  if (input.time !== undefined) {
    if (!isValidTime(input.time)) throw ApiError.badRequest('Time must look like 07:00.')
    update.time = input.time.trim()
  }

  if (input.timezone !== undefined) {
    if (!isValidTimezone(input.timezone)) throw ApiError.badRequest('That is not a timezone this server knows, e.g. Asia/Dhaka.')
    update.timezone = input.timezone.trim()
  }

  if (input.sites !== undefined) {
    const sites: ScheduleSite[] = []
    for (const row of input.sites) {
      const url = row.url.trim().replace(/\/+$/, '')
      if (!url) continue

      // A specific article is refused: a site is drawn from repeatedly, and
      // one pointing at a single article would write the same story every
      // time it came round. A section page (ft.com/technology) is welcome.
      if (classifyTopic(url) === 'keyword') throw ApiError.badRequest(`"${url}" is not a website address. Try techcrunch.com.`)
      if (looksLikeArticleUrl(url)) {
        throw ApiError.badRequest(
          'That points at one article. A site is a publication or section to pick stories from — e.g. techcrunch.com or ft.com/technology.',
        )
      }

      sites.push({
        url,
        notes: typeof row.notes === 'string' ? row.notes.trim() : '',
        enabled: row.enabled !== false,
        lastUsedAt: typeof row.lastUsedAt === 'string' ? row.lastUsedAt : null,
        lastScan: null,
      })
    }

    // The scan record is the watcher's, not the client's: carried over from
    // what is stored, matched by URL, so an edit cannot erase what the last
    // run found.
    const current = await prisma.blogRunSchedule.findUnique({ where: { id }, select: { sites: true } })
    const scans = new Map(readSites(current?.sites).map((site) => [site.url, site.lastScan]))
    update.sites = sites.slice(0, MAX_SCHEDULE_SITES).map((site) => ({
      ...site,
      lastScan: scans.get(site.url) ?? readSiteScan(null),
    })) as unknown as Prisma.InputJsonValue
  }

  if (Object.keys(update).length === 0) throw ApiError.badRequest('Nothing to change.')

  const result = await prisma.blogRunSchedule.updateMany({ where: { id }, data: update })
  if (result.count === 0) throw ApiError.notFound('That schedule no longer exists.')

  return { ok: true }
}

/**
 * Delete a schedule, and give its keywords back to the queue (appended, in
 * their existing order). The row is photographed into blog_deleted_schedules
 * on the way out; that snapshot is never allowed to fail the delete.
 */
async function deleteSchedule(id: string) {
  const schedule = await prisma.blogRunSchedule.findUnique({
    where: { id },
    include: { keywords: { orderBy: { position: 'asc' } } },
  })
  if (!schedule) return { ok: true, returned: 0 }

  const keywords = schedule.keywords

  try {
    await prisma.blogDeletedSchedule.create({
      data: {
        schedule_id: id,
        snapshot: JSON.parse(JSON.stringify(schedule)) as Prisma.InputJsonValue,
        keyword_count: keywords.length,
        completed: keywords.length === 0,
      },
    })
  } catch (error) {
    logger.error('Could not snapshot the schedule before deleting it:', error)
  }

  await prisma.$transaction(async (tx) => {
    // Written back before the schedule goes: the other order has a failure
    // that loses everything.
    if (keywords.length > 0) {
      const last = await tx.blogTopic.findFirst({ orderBy: { order: 'desc' }, select: { order: true } })
      let order = last?.order ?? 0
      await tx.blogTopic.createMany({
        data: keywords.map((keyword) => ({
          topic: keyword.topic,
          kind: classifyTopic(keyword.topic),
          notes: keyword.notes,
          image_count: keyword.image_count,
          words: keyword.words,
          cta_variant: keyword.cta_variant,
          order: (order += 10),
        })),
      })
    }
    // Keywords cascade with the schedule.
    await tx.blogRunSchedule.delete({ where: { id } })
  })

  return { ok: true, returned: keywords.length }
}

/** One page of a schedule's keyword list, sliced in the database. */
async function listKeywords(id: string, query: z.infer<typeof keywordPageQuerySchema>) {
  const limit = query.limit ?? SCHEDULE_KEYWORD_PAGE
  const skip = query.skip

  const schedule = await prisma.blogRunSchedule.findUnique({ where: { id }, select: { id: true } })
  if (!schedule) throw ApiError.notFound('That schedule no longer exists.')

  const [rows, total] = await Promise.all([
    prisma.blogScheduleKeyword.findMany({
      where: { schedule_id: id },
      orderBy: { position: 'asc' },
      skip,
      take: limit,
      select: keywordSelect,
    }),
    prisma.blogScheduleKeyword.count({ where: { schedule_id: id } }),
  ])

  return { keywords: rows.map(serializeKeyword), total, skip, limit }
}

/**
 * Add keywords to the end of a schedule's list. Dropped against what the
 * schedule already holds, and within the paste itself.
 */
async function addKeywords(id: string, input: z.infer<typeof addKeywordsSchema>) {
  const parsed = parseKeywordText(input.topics, input.splitCommas === true)
  if (parsed.length === 0) throw ApiError.badRequest('No keywords in that.')

  const schedule = await prisma.blogRunSchedule.findUnique({
    where: { id },
    include: { keywords: { select: { topic: true } } },
  })
  if (!schedule) throw ApiError.notFound('That schedule no longer exists.')

  const seen = new Set(schedule.keywords.map((keyword) => keyword.topic.trim().toLowerCase()))

  const fresh: ScheduleKeyword[] = []
  for (const keyword of parsed) {
    const key = keyword.topic.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    fresh.push(keyword)
  }

  const held = schedule.keywords.length
  const room = Math.max(0, MAX_SCHEDULE_KEYWORDS - held)
  const taking = fresh.slice(0, room)

  await appendKeywords(id, taking)

  return { added: taking.length, duplicates: parsed.length - fresh.length, overflowed: fresh.length - taking.length }
}

/**
 * Move the whole queue into a schedule. A move, not a copy: the rows leave the
 * queue, become that schedule's backlog, and come back a few a day on their
 * own. Each keeps its own length, images and banner.
 */
async function transferQueue(input: z.infer<typeof transferSchema>) {
  const inFlight = await prisma.blogWriteRequest.findFirst({ where: { status: { in: [...ACTIVE_STATUSES] } } })
  if (inFlight) {
    throw ApiError.conflict(
      'A post is being written. Wait for it to finish, then transfer — moving the queue now would pull the topic out from under it.',
    )
  }

  if (await getActiveBatch()) throw ApiError.conflict('A batch is working through the queue. Press Stop first, then transfer.')

  // Never a row a schedule put here: those are a day's batch in progress.
  const topics = await prisma.blogTopic.findMany({
    where: { status: 'queued', schedule_id: null },
    orderBy: [{ order: 'asc' }, { created_at: 'asc' }],
  })
  if (topics.length === 0) throw ApiError.badRequest('There is nothing in the queue to transfer.')

  const scheduleId = input.scheduleId ?? ''

  let target = scheduleId
    ? await prisma.blogRunSchedule.findUnique({
        where: { id: scheduleId },
        select: { id: true, name: true, mode: true, _count: { select: { keywords: true } } },
      })
    : null

  if (scheduleId && !target) throw ApiError.notFound('That schedule no longer exists.')

  if (target && target.mode !== 'queue') {
    throw ApiError.badRequest(
      `"${target.name}" writes from saved sites, not from a keyword list. Switch it to a keyword schedule first, or transfer into a new one.`,
    )
  }

  if (!target) {
    if (input.time !== undefined && !isValidTime(input.time)) throw ApiError.badRequest('Time must look like 07:00.')
    if (input.timezone !== undefined && !isValidTimezone(input.timezone)) {
      throw ApiError.badRequest('That is not a timezone this server knows, e.g. Asia/Dhaka.')
    }

    const last = await prisma.blogRunSchedule.findFirst({ orderBy: { order: 'desc' }, select: { order: true } })
    const count = await prisma.blogRunSchedule.count()

    const created = await prisma.blogRunSchedule.create({
      data: {
        name: input.name || `Schedule ${count + 1}`,
        // On from the moment it is made: the whole queue has just been handed to it.
        enabled: true,
        mode: 'queue',
        time: isValidTime(input.time) ? input.time.trim() : DEFAULT_RUN_SCHEDULE.time,
        timezone: isValidTimezone(input.timezone) ? input.timezone.trim() : DEFAULT_RUN_SCHEDULE.timezone,
        posts_per_run: 1,
        posts_per_day: clampPerDay(input.postsPerDay),
        image_count: 1,
        words: DEFAULT_WORDS,
        sites: [],
        order: (last?.order ?? 0) + 10,
      },
    })
    target = { id: created.id, name: created.name, mode: created.mode, _count: { keywords: 0 } }
  }

  const held = target._count.keywords
  const room = Math.max(0, MAX_SCHEDULE_KEYWORDS - held)
  const moving = topics.slice(0, room)

  if (moving.length === 0) {
    throw ApiError.badRequest(
      `That schedule already holds ${held} keywords, which is the limit. Let it write some down before transferring more.`,
    )
  }

  const targetId = target.id

  // Appended first, deleted second, in one transaction.
  await prisma.$transaction(async (tx) => {
    await appendKeywords(
      targetId,
      moving.map((topic) => ({
        topic: topic.topic,
        notes: topic.notes,
        imageCount: topic.image_count,
        words: topic.words,
        ctaVariant: topic.cta_variant,
      })),
      tx,
    )
    await tx.blogTopic.deleteMany({ where: { id: { in: moving.map((topic) => topic.id) } } })
  })

  return { scheduleId: targetId, moved: moving.length, remaining: topics.length - moving.length }
}

export default {
  getState,
  createTopic,
  bulkAddTopics,
  updateTopic,
  deleteTopic,
  reorderTopics,
  getDefaults,
  saveDefaults,
  applyDefaults,
  importSheet,
  requestWrite,
  stopBatch,
  closeSummary,
  dismissRun,
  retryRun,
  getSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  listKeywords,
  addKeywords,
  transferQueue,
}
