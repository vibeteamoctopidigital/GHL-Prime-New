import { Router } from 'express'
import { z, type ZodTypeAny } from 'zod'
import { LeadStatus, LEAD_STATUSES } from '../../config/constants.js'
import validate from '../middleware/validate.js'
import authenticate from '../middleware/authenticate.js'
import { authorizeContentManager } from '../middleware/authorize.js'
import { submissionLimiter } from '../middleware/rateLimiter.js'
import asyncHandler from '../utils/asyncHandler.js'
import { sendCreated, sendOk } from '../utils/ApiResponse.js'
import { idParamSchema } from '../validators/common.validators.js'
import type LeadService from '../services/LeadService.js'
import type { SerializedRow } from '../../types/common.js'

export const leadListQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
    search: z.string().trim().optional(),
    status: z.nativeEnum(LeadStatus).optional(),
  })
  .passthrough()

export const leadStatusSchema = z.object({
  status: z.nativeEnum(LeadStatus),
  notes: z.string().trim().optional().nullable(),
})

export interface LeadRouterOptions<TBody> {
  service: LeadService
  /** Validates the public submission body. */
  submitSchema: ZodTypeAny
  /** Runs the actual submission (spam check, persist, forward). */
  submit: (body: TBody) => Promise<SerializedRow | { ok: true; spam: true }>
  label: string
  /** Sub-path the admin inbox is mounted at. Default '/leads'. */
  inboxPath?: string
}

/**
 * Assembles the routes every lead-capture form needs. The public submit route
 * and the admin inbox live under different prefixes so a submission can never
 * be mistaken for a record id.
 *
 *   POST   /submit                public, rate limited
 *   GET    /<inbox>               admin inbox (paginated, filterable)
 *   GET    /<inbox>/stats         counts per status
 *   GET    /<inbox>/:id           single lead
 *   PATCH  /<inbox>/:id/status    move through the pipeline
 *   DELETE /<inbox>/:id           remove
 */
export function createLeadRouter<TBody>({
  service,
  submitSchema,
  submit,
  label,
  inboxPath = '/leads',
}: LeadRouterOptions<TBody>): Router {
  const router = Router()
  const inbox = Router()
  const guard = [authenticate, authorizeContentManager]

  router.post(
    '/submit',
    submissionLimiter,
    validate({ body: submitSchema }),
    asyncHandler(async (req, res) => {
      const data = await submit(req.body as TBody)
      return sendCreated(res, { data, message: `${label} submitted successfully` })
    }),
  )

  // '/stats' precedes '/:id' so it is not parsed as an id.
  inbox.get(
    '/stats',
    ...guard,
    asyncHandler(async (_req, res) => {
      const data = await service.statusCounts()
      return sendOk(res, data, `${label} stats retrieved`)
    }),
  )

  inbox.get(
    '/',
    ...guard,
    validate({ query: leadListQuerySchema }),
    asyncHandler(async (req, res) => {
      const query = req.query as unknown as z.infer<typeof leadListQuerySchema>
      const { data, meta } = await service.listLeads(query)
      return sendOk(res, data, `${label} list retrieved`, meta)
    }),
  )

  inbox.get(
    '/:id',
    ...guard,
    validate({ params: idParamSchema }),
    asyncHandler(async (req, res) => {
      const data = await service.findByIdOrFail(req.params['id'] as string)
      return sendOk(res, data, `${label} retrieved`)
    }),
  )

  inbox.patch(
    '/:id/status',
    ...guard,
    validate({ params: idParamSchema, body: leadStatusSchema }),
    asyncHandler(async (req, res) => {
      const { status, notes } = req.body as z.infer<typeof leadStatusSchema>
      const data = await service.updateStatus(req.params['id'] as string, status, notes)
      return sendOk(res, data, `${label} updated successfully`)
    }),
  )

  inbox.delete(
    '/:id',
    ...guard,
    validate({ params: idParamSchema }),
    asyncHandler(async (req, res) => {
      const data = await service.remove(req.params['id'] as string)
      return sendOk(res, data, `${label} deleted successfully`)
    }),
  )

  router.use(inboxPath, inbox)

  return router
}

export default createLeadRouter
