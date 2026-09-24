import type { Prisma } from '@prisma/client'
import prisma from '../../config/prisma.js'
import { normalizeCtaChoice, DEFAULT_CTA_VARIANT } from './lib/cta-variants.js'
import {
  DEFAULT_QUEUE_DEFAULTS,
  SETTING_KEYS,
  clampImages,
  clampPerDay,
  clampPerRun,
  clampWords,
  isCtaVariantId,
  type QueueDefaults,
} from './lib/rules.js'
import {
  DEFAULT_RUN_SCHEDULE,
  SCHEDULE_KEYWORD_PAGE,
  isRunMode,
  isValidTime,
  isValidTimezone,
  readSites,
  type ScheduleKeyword,
  type ScheduleRow,
} from './lib/run-schedule.js'

/**
 * Reading and writing the queue's stored state.
 *
 * Split from lib/rules.ts because that file is pure and mirrored into the
 * dashboard; everything here touches Prisma. Shared by the API module and by
 * the scripts (watcher, queue printer, importer) so the two cannot drift on
 * what a setting row means.
 */

/* -------------------------------------------------------------------------- */
/* Settings (key/value)                                                       */
/* -------------------------------------------------------------------------- */

export async function getSetting(key: string): Promise<string | null> {
  const row = await prisma.blogWriterSetting.findUnique({ where: { key } })
  return row?.value ?? null
}

export async function setSetting(key: string, value: string): Promise<void> {
  await prisma.blogWriterSetting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  })
}

export async function getSettings(keys: string[]): Promise<Map<string, string>> {
  const rows = await prisma.blogWriterSetting.findMany({ where: { key: { in: keys } } })
  return new Map(rows.map((row) => [row.key, row.value]))
}

/**
 * The CTA banner pinned as the default for NEW posts. Only decides what a
 * form starts with — once a post is saved it carries its own id forever.
 */
export async function getDefaultCtaVariant(): Promise<string> {
  try {
    // normalizeCtaChoice, not normalizeCtaVariant: the pin can legitimately
    // be "random".
    return normalizeCtaChoice(await getSetting(SETTING_KEYS.ctaDefault))
  } catch {
    return DEFAULT_CTA_VARIANT
  }
}

export async function setDefaultCtaVariant(variant: string): Promise<string> {
  const value = normalizeCtaChoice(variant)
  await setSetting(SETTING_KEYS.ctaDefault, value)
  return value
}

/**
 * The queue defaults, with anything unset or corrupt falling back to the
 * built-in values. Never throws: a settings table that cannot be read should
 * cost the editor the defaults they chose, not the whole screen.
 */
export async function getQueueDefaults(): Promise<QueueDefaults> {
  try {
    const [byKey, ctaVariant] = await Promise.all([
      getSettings([SETTING_KEYS.postsPerRun, SETTING_KEYS.imageCount, SETTING_KEYS.words, SETTING_KEYS.autoPublish]),
      getDefaultCtaVariant(),
    ])

    return {
      postsPerRun: byKey.has(SETTING_KEYS.postsPerRun)
        ? clampPerRun(byKey.get(SETTING_KEYS.postsPerRun))
        : DEFAULT_QUEUE_DEFAULTS.postsPerRun,
      imageCount: byKey.has(SETTING_KEYS.imageCount)
        ? clampImages(byKey.get(SETTING_KEYS.imageCount))
        : DEFAULT_QUEUE_DEFAULTS.imageCount,
      words: byKey.has(SETTING_KEYS.words) ? clampWords(byKey.get(SETTING_KEYS.words)) : DEFAULT_QUEUE_DEFAULTS.words,
      ctaVariant,
      // Opt-in in the strictest sense: only the exact string "true" turns it on.
      autoPublish: byKey.get(SETTING_KEYS.autoPublish) === 'true',
    }
  } catch {
    return DEFAULT_QUEUE_DEFAULTS
  }
}

/** Save the defaults. Values are validated by the caller before they get here. */
export async function setQueueDefaults(next: QueueDefaults): Promise<void> {
  await Promise.all([
    setSetting(SETTING_KEYS.postsPerRun, String(next.postsPerRun)),
    setSetting(SETTING_KEYS.imageCount, String(next.imageCount)),
    setSetting(SETTING_KEYS.words, String(next.words)),
    setSetting(SETTING_KEYS.autoPublish, next.autoPublish ? 'true' : 'false'),
    setDefaultCtaVariant(next.ctaVariant),
  ])
}

/** Whether finished posts go live without a person reading them. Any failure answers "no". */
export async function autoPublishEnabled(): Promise<boolean> {
  try {
    return (await getSetting(SETTING_KEYS.autoPublish)) === 'true'
  } catch {
    return false
  }
}

export async function getActiveBatch(): Promise<string> {
  return (await getSetting(SETTING_KEYS.activeBatch)) ?? ''
}

export async function setActiveBatch(batchId: string): Promise<void> {
  await setSetting(SETTING_KEYS.activeBatch, batchId)
}

/* -------------------------------------------------------------------------- */
/* Heartbeat                                                                  */
/* -------------------------------------------------------------------------- */

/** When the writer last reported in. Null means it has never run. */
export async function getWriterLastSeen(): Promise<Date | null> {
  try {
    const value = await getSetting(SETTING_KEYS.writerLastSeen)
    if (!value) return null
    const at = new Date(value)
    return Number.isNaN(at.getTime()) ? null : at
  } catch {
    return null
  }
}

/** Called by the watcher every few seconds, so a dead watcher goes stale by itself. */
export async function touchWriterHeartbeat(): Promise<void> {
  await setSetting(SETTING_KEYS.writerLastSeen, new Date().toISOString())
}

/* -------------------------------------------------------------------------- */
/* Topics                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The next position to append at. Sparse by design: gaps left by deleted rows
 * are never backfilled, because renumbering the whole queue would fight with
 * anyone else reordering at the same time.
 */
export async function nextTopicOrder(): Promise<number> {
  const last = await prisma.blogTopic.findFirst({ orderBy: { order: 'desc' }, select: { order: true } })
  return (last?.order ?? 0) + 10
}

/** A position in front of everything queued, for rows that must be written next. */
export async function frontTopicOrder(count: number): Promise<number> {
  const first = await prisma.blogTopic.findFirst({ orderBy: { order: 'asc' }, select: { order: true } })
  return (first?.order ?? 0) - 10 * (count + 1)
}

/* -------------------------------------------------------------------------- */
/* Schedules                                                                  */
/* -------------------------------------------------------------------------- */

export const keywordSelect = {
  topic: true,
  notes: true,
  image_count: true,
  words: true,
  cta_variant: true,
} as const

export function serializeKeyword(row: {
  topic: string
  notes: string
  image_count: number | null
  words: number | null
  cta_variant: string
}): ScheduleKeyword {
  return {
    topic: row.topic,
    notes: row.notes,
    imageCount: row.image_count,
    words: row.words,
    ctaVariant: row.cta_variant,
  }
}

/**
 * Every alarm, with anything missing or invalid falling back per field, and
 * only the first page of each one's keywords. Never throws.
 */
export async function listSchedules(): Promise<ScheduleRow[]> {
  try {
    const rows = await prisma.blogRunSchedule.findMany({
      orderBy: [{ order: 'asc' }, { created_at: 'asc' }],
      include: {
        keywords: { orderBy: { position: 'asc' }, take: SCHEDULE_KEYWORD_PAGE, select: keywordSelect },
        _count: { select: { keywords: true } },
      },
    })

    return rows.map((row) => ({
      id: row.id,
      name: row.name || 'Schedule',
      enabled: row.enabled === true,
      mode: isRunMode(row.mode) ? row.mode : DEFAULT_RUN_SCHEDULE.mode,
      time: isValidTime(row.time) ? row.time : DEFAULT_RUN_SCHEDULE.time,
      timezone: isValidTimezone(row.timezone) ? row.timezone : DEFAULT_RUN_SCHEDULE.timezone,
      postsPerRun: clampPerRun(row.posts_per_run),
      postsPerDay: clampPerDay(row.posts_per_day),
      keywordCount: row._count.keywords,
      sheetUrl: row.sheet_url,
      imageCount: clampImages(row.image_count),
      words: clampWords(row.words),
      ctaVariant: isCtaVariantId(row.cta_variant) ? row.cta_variant : '',
      keywords: row.keywords.map(serializeKeyword),
      sites: readSites(row.sites),
      lastRunDay: row.last_run_day,
    }))
  } catch {
    return []
  }
}

/** The position after a schedule's last keyword. */
export async function nextKeywordPosition(scheduleId: string): Promise<number> {
  const last = await prisma.blogScheduleKeyword.findFirst({
    where: { schedule_id: scheduleId },
    orderBy: { position: 'desc' },
    select: { position: true },
  })
  return (last?.position ?? 0) + 10
}

/** Append keywords to the END of a schedule's list, in the order given. */
export async function appendKeywords(
  scheduleId: string,
  keywords: ScheduleKeyword[],
  tx: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<void> {
  if (keywords.length === 0) return
  const last = await tx.blogScheduleKeyword.findFirst({
    where: { schedule_id: scheduleId },
    orderBy: { position: 'desc' },
    select: { position: true },
  })
  let position = last?.position ?? 0
  await tx.blogScheduleKeyword.createMany({
    data: keywords.map((keyword) => ({
      schedule_id: scheduleId,
      position: (position += 10),
      topic: keyword.topic,
      notes: keyword.notes,
      image_count: keyword.imageCount,
      words: keyword.words,
      cta_variant: keyword.ctaVariant,
    })),
  })
}

/** Put keywords at the FRONT of a schedule's list, so tomorrow's run takes them first. */
export async function prependKeywords(
  scheduleId: string,
  keywords: ScheduleKeyword[],
  tx: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<void> {
  if (keywords.length === 0) return
  const first = await tx.blogScheduleKeyword.findFirst({
    where: { schedule_id: scheduleId },
    orderBy: { position: 'asc' },
    select: { position: true },
  })
  let position = (first?.position ?? 0) - 10 * (keywords.length + 1)
  await tx.blogScheduleKeyword.createMany({
    data: keywords.map((keyword) => ({
      schedule_id: scheduleId,
      position: (position += 10),
      topic: keyword.topic,
      notes: keyword.notes,
      image_count: keyword.imageCount,
      words: keyword.words,
      cta_variant: keyword.ctaVariant,
    })),
  })
}
