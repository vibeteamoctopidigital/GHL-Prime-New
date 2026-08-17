import type { RequestHandler } from 'express'
import asyncHandler from '../utils/asyncHandler.js'
import { sendCreated, sendOk } from '../utils/ApiResponse.js'
import type SortableService from '../services/SortableService.js'
import type { ReorderBody } from '../validators/common.validators.js'

export interface CrudController {
  listPublic: RequestHandler
  listAll: RequestHandler
  getById: RequestHandler
  create: RequestHandler
  update: RequestHandler
  remove: RequestHandler
  reorder: RequestHandler
}

/**
 * Builds the standard controller set for a resource backed by a
 * SortableService. Modules override individual handlers by spreading the
 * result and replacing what they need.
 *
 *   const controller = { ...createCrudController(service, 'Blog post'), publish }
 */
export function createCrudController<TRow extends { id: string }>(
  service: SortableService<TRow>,
  label: string = service.resourceName,
): CrudController {
  return {
    /** GET / — public listing (published only). */
    listPublic: asyncHandler(async (req, res) => {
      const data = await service.listPublic({ search: req.query['search'] as string | undefined })
      return sendOk(res, data, `${label} list retrieved`)
    }),

    /** GET /admin — full listing including drafts. */
    listAll: asyncHandler(async (req, res) => {
      const data = await service.listAll({ search: req.query['search'] as string | undefined })
      return sendOk(res, data, `${label} admin list retrieved`)
    }),

    /** GET /:id */
    getById: asyncHandler(async (req, res) => {
      const data = await service.findByIdOrFail(req.params['id'] as string)
      return sendOk(res, data, `${label} retrieved`)
    }),

    /** POST / */
    create: asyncHandler(async (req, res) => {
      const data = await service.create(req.body as Record<string, unknown>)
      return sendCreated(res, { data, message: `${label} created successfully` })
    }),

    /** PUT|PATCH /:id */
    update: asyncHandler(async (req, res) => {
      const data = await service.update(req.params['id'] as string, req.body as Record<string, unknown>)
      return sendOk(res, data, `${label} updated successfully`)
    }),

    /** DELETE /:id */
    remove: asyncHandler(async (req, res) => {
      const data = await service.remove(req.params['id'] as string)
      return sendOk(res, data, `${label} deleted successfully`)
    }),

    /** PATCH /reorder */
    reorder: asyncHandler(async (req, res) => {
      const data = await service.reorder((req.body as ReorderBody).items)
      return sendOk(res, data, `${label} order updated successfully`)
    }),
  }
}

export default createCrudController
