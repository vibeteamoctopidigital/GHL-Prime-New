import prisma from '../../config/prisma.js'
import ApiError from '../../shared/utils/ApiError.js'
import logger from '../../shared/utils/logger.js'
import type {
  createScheduleSchema,
  createTopicSchema,
  createWriteRequestSchema,
  listRequestsQuerySchema,
  updateScheduleSchema,
  updateSettingsSchema,
} from './blogWriter.validators.js'
import type { z } from 'zod'

type CreateTopicInput = z.infer<typeof createTopicSchema>
type CreateWriteRequestInput = z.infer<typeof createWriteRequestSchema>
type ListRequestsQuery = z.infer<typeof listRequestsQuerySchema>
type CreateScheduleInput = z.infer<typeof createScheduleSchema>
type UpdateScheduleInput = z.infer<typeof updateScheduleSchema>
type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>

/** A heartbeat older than this reads as the watcher being offline. Matches the spec's 15s-beat / 2min-timeout pair. */
const HEARTBEAT_OFFLINE_AFTER_MS = 2 * 60 * 1000

// ---------------------------------------------------------------------------
// Settings (singleton row) + status
// ---------------------------------------------------------------------------

/** Fetch-or-create the one settings row — same `id: true` singleton idiom BlogAiSettings used. */
async function getOrCreateSettings() {
  return prisma.blogWriterSettings.upsert({
    where: { id: true },
    update: {},
    create: { id: true },
  })
}

async function getSettings() {
  return getOrCreateSettings()
}

async function updateSettings(input: UpdateSettingsInput) {
  await getOrCreateSettings()
  return prisma.blogWriterSettings.update({
    where: { id: true },
    data: { ...input, updated_at: new Date() },
  })
}

/** "Stop" from the admin screen — see the field comment on BlogWriterSettings.stop_requested for exactly what this does and doesn't interrupt. */
async function requestStop() {
  await getOrCreateSettings()
  return prisma.blogWriterSettings.update({ where: { id: true }, data: { stop_requested: true } })
}

/**
 * What the admin badge polls. `online` is derived here, not stored — the
 * watcher only ever writes `last_heartbeat_at`/`last_heartbeat_host`, so a
 * crashed watcher just stops updating them and this naturally ages out to
 * offline rather than needing its own liveness check.
 */
async function getStatus() {
  const settings = await getOrCreateSettings()
  const lastBeat = settings.last_heartbeat_at
  const online = Boolean(lastBeat) && Date.now() - lastBeat!.getTime() < HEARTBEAT_OFFLINE_AFTER_MS

  const [runningCount, pendingCount, waitingCount] = await Promise.all([
    prisma.blogWriteRequest.count({ where: { status: 'running' } }),
    prisma.blogWriteRequest.count({ where: { status: 'pending' } }),
    prisma.blogWriteRequest.count({ where: { status: 'waiting' } }),
  ])

  return {
    online,
    last_heartbeat_at: lastBeat,
    auto_publish_enabled: settings.auto_publish_enabled,
    running_count: runningCount,
    pending_count: pendingCount,
    waiting_count: waitingCount,
  }
}

// ---------------------------------------------------------------------------
// Topics (the queue)
// ---------------------------------------------------------------------------

async function listTopics() {
  return prisma.blogTopic.findMany({
    orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }],
  })
}

async function createTopic(input: CreateTopicInput) {
  const last = await prisma.blogTopic.findFirst({ orderBy: { sort_order: 'desc' } })

  return prisma.blogTopic.create({
    data: {
      title: input.title,
      target_keyword: input.target_keyword ?? null,
      category: input.category ?? null,
      research_mode: input.research_mode,
      source: 'manual',
      sort_order: (last?.sort_order ?? 0) + 1,
    },
  })
}

async function deleteTopic(id: string) {
  const topic = await prisma.blogTopic.findUnique({ where: { id } })
  if (!topic) throw ApiError.notFound('Topic not found')

  await prisma.blogTopic.delete({ where: { id } })
}

// ---------------------------------------------------------------------------
// Write requests (one row per attempt to write a post)
// ---------------------------------------------------------------------------

const ACTIVE_REQUEST_STATUSES = ['pending', 'running', 'waiting'] as const

async function createWriteRequest(input: CreateWriteRequestInput) {
  if (input.topic_id) {
    const topic = await prisma.blogTopic.findUnique({ where: { id: input.topic_id } })
    if (!topic) throw ApiError.notFound('Topic not found')

    const active = await prisma.blogWriteRequest.findFirst({
      where: { topic_id: input.topic_id, status: { in: [...ACTIVE_REQUEST_STATUSES] } },
    })
    if (active) throw ApiError.conflict('This topic already has a request in progress')

    return prisma.$transaction(async (tx) => {
      const request = await tx.blogWriteRequest.create({
        data: { topic_id: input.topic_id, status: 'pending' },
      })
      await tx.blogTopic.update({ where: { id: input.topic_id! }, data: { status: 'queued' } })
      return request
    })
  }

  return prisma.blogWriteRequest.create({
    data: { ad_hoc_title: input.ad_hoc_title, status: 'pending' },
  })
}

async function listRequests(query: ListRequestsQuery) {
  const requests = await prisma.blogWriteRequest.findMany({
    where: query.status ? { status: query.status } : undefined,
    orderBy: { created_at: 'desc' },
    take: query.limit + 1,
    ...(query.cursor ? { skip: 1, cursor: { id: query.cursor } } : {}),
    include: {
      topic: { select: { id: true, title: true, target_keyword: true } },
      blog_post: { select: { id: true, slug: true, title: true, published: true } },
    },
  })

  const hasMore = requests.length > query.limit
  const page = hasMore ? requests.slice(0, query.limit) : requests
  return { data: page, next_cursor: hasMore ? page[page.length - 1]?.id ?? null : null }
}

async function retryRequest(id: string) {
  const request = await prisma.blogWriteRequest.findUnique({ where: { id } })
  if (!request) throw ApiError.notFound('Request not found')
  if (request.status !== 'failed') {
    throw ApiError.badRequest('Only a failed request can be retried')
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.blogWriteRequest.update({
      where: { id },
      data: {
        status: 'pending',
        // A manual retry is a fresh decision by a human, not another hop of
        // the watcher's own usage-limit backoff — reset the counter so it
        // gets the full automatic-retry budget again if it hits a limit.
        retry_count: 0,
        retry_after: null,
        error: null,
        phase: null,
      },
    })

    if (request.topic_id) {
      await tx.blogTopic.update({ where: { id: request.topic_id }, data: { status: 'queued', skip_reason: null } })
    }

    return updated
  })
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

async function listSchedules() {
  return prisma.blogRunSchedule.findMany({ orderBy: { created_at: 'asc' } })
}

async function createSchedule(input: CreateScheduleInput) {
  return prisma.blogRunSchedule.create({ data: input })
}

async function updateSchedule(id: string, input: UpdateScheduleInput) {
  const schedule = await prisma.blogRunSchedule.findUnique({ where: { id } })
  if (!schedule) throw ApiError.notFound('Schedule not found')

  return prisma.blogRunSchedule.update({ where: { id }, data: input })
}

/** Snapshot-then-delete, per the "soft-delete via a full copy" design on BlogDeletedSchedule. */
async function deleteSchedule(id: string, deletedBy: string | null) {
  const schedule = await prisma.blogRunSchedule.findUnique({ where: { id } })
  if (!schedule) throw ApiError.notFound('Schedule not found')

  await prisma.$transaction([
    prisma.blogDeletedSchedule.create({
      data: {
        original_schedule_id: schedule.id,
        snapshot: JSON.parse(JSON.stringify(schedule)),
        deleted_by: deletedBy,
      },
    }),
    prisma.blogRunSchedule.delete({ where: { id } }),
  ])

  logger.info(`Blog Writer schedule "${schedule.label}" (${id}) deleted — snapshot kept in blog_deleted_schedules`)
}

export default {
  getSettings,
  updateSettings,
  requestStop,
  getStatus,
  listTopics,
  createTopic,
  deleteTopic,
  createWriteRequest,
  listRequests,
  retryRequest,
  listSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
}
