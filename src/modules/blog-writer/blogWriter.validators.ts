import { z } from 'zod'
import { TOPIC_STATUSES } from './lib/rules.js'

/**
 * Request shapes for /api/blog-writer. Loose on purpose where octopi's routes
 * were loose: counts are clamped by the service rather than rejected here
 * (a slider pushed too far is not a mistake worth an error message), while
 * things that would silently do the wrong thing — an unknown CTA id, a
 * malformed time — are rejected by the service with a message.
 */

const optionalTrimmed = z.string().trim().optional()

/** A number, or null to clear an override. Absent means "not sent". */
const nullableNumber = z.number().nullable().optional()

export const createTopicSchema = z.object({
  topic: z.string().trim().min(1, 'A topic is required.'),
  notes: optionalTrimmed,
  imageCount: z.number().optional(),
  words: z.number().optional(),
  ctaVariant: optionalTrimmed,
})

export const bulkTopicsSchema = z.object({
  topics: z.array(z.string()).min(1, 'Nothing to add.'),
})

export const updateTopicSchema = z.object({
  topic: optionalTrimmed,
  notes: optionalTrimmed,
  imageCount: nullableNumber,
  words: nullableNumber,
  ctaVariant: optionalTrimmed,
  status: z.enum(TOPIC_STATUSES).optional(),
  skipReason: optionalTrimmed,
})

export const reorderSchema = z.object({
  ids: z.array(z.string().uuid()).min(1, 'No order given.'),
})

export const defaultsSchema = z.object({
  postsPerRun: z.unknown(),
  imageCount: z.unknown(),
  words: z.unknown(),
  ctaVariant: z.unknown(),
  autoPublish: z.unknown(),
})

export const importSheetSchema = z.object({
  url: z.string().trim().min(1, 'A sheet link is required.'),
  scheduleId: z.string().uuid().optional(),
})

export const requestWriteSchema = z
  .object({
    topicId: z.string().uuid().optional(),
    all: z.boolean().optional(),
  })
  .default({})

export const createScheduleSchema = z
  .object({
    name: optionalTrimmed,
    enabled: z.boolean().optional(),
    mode: z.unknown().optional(),
    time: z.unknown().optional(),
    timezone: z.unknown().optional(),
    postsPerDay: z.unknown().optional(),
  })
  .default({})

const siteInputSchema = z.object({
  url: z.string(),
  notes: z.string().optional(),
  enabled: z.boolean().optional(),
  lastUsedAt: z.string().nullable().optional(),
  lastScan: z.unknown().optional(),
})

export const updateScheduleSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  postsPerRun: z.unknown().optional(),
  postsPerDay: z.unknown().optional(),
  imageCount: z.unknown().optional(),
  words: z.unknown().optional(),
  ctaVariant: z.unknown().optional(),
  sheetUrl: z.unknown().optional(),
  mode: z.unknown().optional(),
  time: z.unknown().optional(),
  timezone: z.unknown().optional(),
  sites: z.array(siteInputSchema).optional(),
})

export const keywordPageQuerySchema = z.object({
  skip: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})

export const addKeywordsSchema = z.object({
  topics: z.string().min(1, 'Nothing to add.'),
  splitCommas: z.boolean().optional(),
})

export const transferSchema = z
  .object({
    scheduleId: optionalTrimmed,
    name: optionalTrimmed,
    time: z.unknown().optional(),
    timezone: z.unknown().optional(),
    postsPerDay: z.unknown().optional(),
  })
  .default({})
