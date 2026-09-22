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
 * /api/blog-writer — the AI Blog Writer's queue, batches and schedules.
 *
 * The same surface as octopi's /api/dashboard/blog-queue/*, one route each,
 * mounted flat under this prefix the way every other module here is. Every
 * route is admin-only: this manages what an unattended CLI session writes
 * and (optionally) auto-publishes, not a public read surface.
 */
const router = Router()

router.get(
  '/',
  createModuleIndex('/blog-writer', [
    { method: 'GET', path: '/state', description: 'Everything the writer screen needs: queue page, defaults, writer status, active run, batch, summary, recent runs' },
    { method: 'POST', path: '/topics', description: 'Add one topic to the end of the queue' },
    { method: 'POST', path: '/topics/bulk', description: 'Add a pasted list of topics' },
    { method: 'POST', path: '/topics/reorder', description: 'Set the queue order from a list of ids' },
    { method: 'PATCH', path: '/topics/:id', description: 'Edit one topic (only the fields sent)' },
    { method: 'DELETE', path: '/topics/:id', description: 'Remove a topic' },
    { method: 'GET', path: '/defaults', description: 'The queue defaults every topic inherits' },
    { method: 'PUT', path: '/defaults', description: 'Save the defaults' },
    { method: 'POST', path: '/defaults/apply', description: 'Clear per-topic overrides so every queued topic follows the defaults' },
    { method: 'POST', path: '/import-sheet', description: 'Fill the queue (or a schedule) from a Google Sheets content calendar' },
    { method: 'POST', path: '/request', description: '"Write next post" / "Write all" — records the ask; the watcher does the writing' },
    { method: 'DELETE', path: '/batch', description: 'Stop the batch after the post being written now' },
    { method: 'DELETE', path: '/summary', description: 'Close the run summary (draws the line at now)' },
    { method: 'DELETE', path: '/runs/:id', description: 'Dismiss a finished run from the recent list' },
    { method: 'POST', path: '/runs/:id/retry', description: 'Try a failed run again' },
    { method: 'GET', path: '/schedules', description: 'Every schedule, with the first page of its keywords' },
    { method: 'POST', path: '/schedules', description: 'Add a schedule' },
    { method: 'PATCH', path: '/schedules/:id', description: 'Edit a schedule (only the fields sent)' },
    { method: 'DELETE', path: '/schedules/:id', description: 'Delete a schedule; its keywords return to the queue' },
    { method: 'GET', path: '/schedules/:id/keywords', description: 'One page of a schedule’s keyword list' },
    { method: 'POST', path: '/schedules/:id/keywords', description: 'Append keywords to a schedule' },
    { method: 'POST', path: '/transfer', description: 'Move the whole queue into a schedule' },
  ]),
)

router.use(authenticate, authorizeAdmin)

router.get('/state', asyncHandler(async (_req, res) => sendOk(res, await blogWriterService.getState())))

router.post('/topics', validate({ body: createTopicSchema }), asyncHandler(async (req, res) =>
  sendCreated(res, { data: await blogWriterService.createTopic(req.body) }),
))

router.post('/topics/bulk', validate({ body: bulkTopicsSchema }), asyncHandler(async (req, res) =>
  sendCreated(res, { data: await blogWriterService.bulkAddTopics(req.body) }),
))

router.post('/topics/reorder', validate({ body: reorderSchema }), asyncHandler(async (req, res) =>
  sendOk(res, await blogWriterService.reorderTopics(req.body)),
))

router.patch('/topics/:id', validate({ params: idParamSchema, body: updateTopicSchema }), asyncHandler(async (req, res) =>
  sendOk(res, await blogWriterService.updateTopic(req.params['id'] as string, req.body)),
))

router.delete('/topics/:id', validate({ params: idParamSchema }), asyncHandler(async (req, res) =>
  sendOk(res, await blogWriterService.deleteTopic(req.params['id'] as string)),
))

router.get('/defaults', asyncHandler(async (_req, res) => sendOk(res, await blogWriterService.getDefaults())))

router.put('/defaults', validate({ body: defaultsSchema }), asyncHandler(async (req, res) =>
  sendOk(res, await blogWriterService.saveDefaults(req.body)),
))

router.post('/defaults/apply', asyncHandler(async (_req, res) => sendOk(res, await blogWriterService.applyDefaults())))

router.post('/import-sheet', validate({ body: importSheetSchema }), asyncHandler(async (req, res) =>
  sendCreated(res, { data: await blogWriterService.importSheet(req.body) }),
))

router.post('/request', validate({ body: requestWriteSchema }), asyncHandler(async (req, res) =>
  sendCreated(res, { data: await blogWriterService.requestWrite(req.body, req.user?.email ?? '') }),
))

router.delete('/batch', asyncHandler(async (_req, res) => sendOk(res, await blogWriterService.stopBatch())))

router.delete('/summary', asyncHandler(async (_req, res) => sendOk(res, await blogWriterService.closeSummary())))

router.delete('/runs/:id', validate({ params: idParamSchema }), asyncHandler(async (req, res) =>
  sendOk(res, await blogWriterService.dismissRun(req.params['id'] as string)),
))

router.post('/runs/:id/retry', validate({ params: idParamSchema }), asyncHandler(async (req, res) =>
  sendOk(res, await blogWriterService.retryRun(req.params['id'] as string)),
))

router.get('/schedules', asyncHandler(async (_req, res) => sendOk(res, await blogWriterService.getSchedules())))

router.post('/schedules', validate({ body: createScheduleSchema }), asyncHandler(async (req, res) =>
  sendCreated(res, { data: await blogWriterService.createSchedule(req.body) }),
))

router.patch('/schedules/:id', validate({ params: idParamSchema, body: updateScheduleSchema }), asyncHandler(async (req, res) =>
  sendOk(res, await blogWriterService.updateSchedule(req.params['id'] as string, req.body)),
))

router.delete('/schedules/:id', validate({ params: idParamSchema }), asyncHandler(async (req, res) =>
  sendOk(res, await blogWriterService.deleteSchedule(req.params['id'] as string)),
))

router.get('/schedules/:id/keywords', validate({ params: idParamSchema, query: keywordPageQuerySchema }), asyncHandler(async (req, res) =>
  sendOk(res, await blogWriterService.listKeywords(req.params['id'] as string, req.query as never)),
))

router.post('/schedules/:id/keywords', validate({ params: idParamSchema, body: addKeywordsSchema }), asyncHandler(async (req, res) =>
  sendOk(res, await blogWriterService.addKeywords(req.params['id'] as string, req.body)),
))

router.post('/transfer', validate({ body: transferSchema }), asyncHandler(async (req, res) =>
  sendOk(res, await blogWriterService.transferQueue(req.body)),
))

export default router
