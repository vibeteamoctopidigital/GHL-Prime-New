import { Router } from 'express'
import authenticate from '../../shared/middleware/authenticate.js'
import { authorizeAdmin } from '../../shared/middleware/authorize.js'
import validate from '../../shared/middleware/validate.js'
import asyncHandler from '../../shared/utils/asyncHandler.js'
import { sendCreated, sendOk } from '../../shared/utils/ApiResponse.js'
import { idParamSchema } from '../../shared/validators/common.validators.js'
import createModuleIndex from '../../shared/factories/createModuleIndex.js'
import blogWriterService from './blogWriter.service.js'
import {
  createScheduleSchema,
  createTopicSchema,
  createWriteRequestSchema,
  listRequestsQuerySchema,
  updateScheduleSchema,
  updateSettingsSchema,
} from './blogWriter.validators.js'
import type { z } from 'zod'

type ListRequestsQuery = z.infer<typeof listRequestsQuerySchema>

const router = Router()

router.get('/', createModuleIndex('/blog-writer', [
  { method: 'GET', path: '/status', description: 'Watcher heartbeat + queue counts, for the admin Online/Offline badge' },
  { method: 'GET', path: '/settings', description: 'Blog Writer settings (auto-publish, model, SEO thresholds)' },
  { method: 'PUT', path: '/settings', description: 'Update Blog Writer settings' },
  { method: 'POST', path: '/stop', description: 'Stop the current batch/schedule chain after the post in progress finishes' },
  { method: 'GET', path: '/topics', description: 'List the topic queue' },
  { method: 'POST', path: '/topics', description: 'Add a topic to the queue' },
  { method: 'DELETE', path: '/topics/:id', description: 'Remove a topic from the queue' },
  { method: 'GET', path: '/requests', description: 'Run history / live request list' },
  { method: 'POST', path: '/requests', description: '"Write next post" — queues a request; the watcher does the actual writing' },
  { method: 'POST', path: '/requests/:id/retry', description: 'Re-queue a failed request' },
  { method: 'GET', path: '/schedules', description: 'List recurring schedules' },
  { method: 'POST', path: '/schedules', description: 'Create a recurring schedule' },
  { method: 'PUT', path: '/schedules/:id', description: 'Update a schedule' },
  { method: 'DELETE', path: '/schedules/:id', description: 'Delete a schedule (snapshotted first, see blog_deleted_schedules)' },
]))

// Every route below is admin-only, same as blog-ai before it: this manages
// what an unattended CLI session writes and (optionally) auto-publishes, not
// a public read surface like /blog or /case-studies.
router.use(authenticate, authorizeAdmin)

router.get('/status', asyncHandler(async (_req, res) => {
  const status = await blogWriterService.getStatus()
  return sendOk(res, status)
}))

router.get('/settings', asyncHandler(async (_req, res) => {
  const settings = await blogWriterService.getSettings()
  return sendOk(res, settings)
}))

router.put('/settings', validate({ body: updateSettingsSchema }), asyncHandler(async (req, res) => {
  const settings = await blogWriterService.updateSettings(req.body)
  return sendOk(res, settings, 'Settings updated')
}))

router.post('/stop', asyncHandler(async (_req, res) => {
  await blogWriterService.requestStop()
  return sendOk(res, null, 'Stop requested — the current post will finish, the next one will not start early')
}))

router.get('/topics', asyncHandler(async (_req, res) => {
  const topics = await blogWriterService.listTopics()
  return sendOk(res, topics)
}))

router.post('/topics', validate({ body: createTopicSchema }), asyncHandler(async (req, res) => {
  const topic = await blogWriterService.createTopic(req.body)
  return sendCreated(res, { data: topic })
}))

router.delete('/topics/:id', validate({ params: idParamSchema }), asyncHandler(async (req, res) => {
  await blogWriterService.deleteTopic(req.params['id'] as string)
  return sendOk(res, null, 'Topic deleted')
}))

router.get('/requests', validate({ query: listRequestsQuerySchema }), asyncHandler(async (req, res) => {
  // Cursor pagination, not the page-based shape ApiResponse's `meta` is typed
  // for (a request list only ever needs "load older" scrolling, not jump-to-
  // page) — the cursor rides inside `data` instead.
  const result = await blogWriterService.listRequests(req.query as unknown as ListRequestsQuery)
  return sendOk(res, result)
}))

router.post('/requests', validate({ body: createWriteRequestSchema }), asyncHandler(async (req, res) => {
  const request = await blogWriterService.createWriteRequest(req.body)
  return sendCreated(res, { data: request })
}))

router.post('/requests/:id/retry', validate({ params: idParamSchema }), asyncHandler(async (req, res) => {
  const request = await blogWriterService.retryRequest(req.params['id'] as string)
  return sendOk(res, request, 'Request re-queued')
}))

router.get('/schedules', asyncHandler(async (_req, res) => {
  const schedules = await blogWriterService.listSchedules()
  return sendOk(res, schedules)
}))

router.post('/schedules', validate({ body: createScheduleSchema }), asyncHandler(async (req, res) => {
  const schedule = await blogWriterService.createSchedule(req.body)
  return sendCreated(res, { data: schedule })
}))

router.put('/schedules/:id', validate({ params: idParamSchema, body: updateScheduleSchema }), asyncHandler(async (req, res) => {
  const schedule = await blogWriterService.updateSchedule(req.params['id'] as string, req.body)
  return sendOk(res, schedule, 'Schedule updated')
}))

router.delete('/schedules/:id', validate({ params: idParamSchema }), asyncHandler(async (req, res) => {
  await blogWriterService.deleteSchedule(req.params['id'] as string, req.user?.id ?? null)
  return sendOk(res, null, 'Schedule deleted')
}))

export default router
