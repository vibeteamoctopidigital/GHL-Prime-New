import { Router, type RequestHandler } from 'express'
import type { ZodTypeAny } from 'zod'
import validate from '../middleware/validate.js'
import authenticate from '../middleware/authenticate.js'
import { authorizeContentManager } from '../middleware/authorize.js'
import createCrudController, { type CrudController } from './createCrudController.js'
import { idParamSchema, reorderSchema, searchQuerySchema } from '../validators/common.validators.js'
import type SortableService from '../services/SortableService.js'

export interface CrudRouterContext<TRow extends { id: string }> {
  controller: CrudController
  service: SortableService<TRow>
  guard: RequestHandler[]
}

export interface CrudRouterOptions<TRow extends { id: string }> {
  /** A SortableService instance. */
  service: SortableService<TRow>
  createSchema: ZodTypeAny
  updateSchema: ZodTypeAny
  /** Used in response messages. */
  label?: string
  /** Overrides for generated handlers. */
  controller?: Partial<CrudController>
  /** Mount PATCH /reorder. Default true. */
  reorderable?: boolean
  /** Hook to add routes before the `/:id` patterns are registered. */
  extend?: (router: Router, context: CrudRouterContext<TRow>) => void
}

/**
 * Assembles a complete REST router for a resource. Public reads are open;
 * every mutation requires a content-manager JWT.
 *
 *   GET    /            published rows, display order   (public)
 *   GET    /admin       all rows including drafts       (auth)
 *   PATCH  /reorder     bulk sort_order update          (auth)
 *   GET    /:id         single row                      (public)
 *   POST   /            create                          (auth)
 *   PUT    /:id         update                          (auth)
 *   PATCH  /:id         update                          (auth)
 *   DELETE /:id         delete                          (auth)
 */
export function createCrudRouter<TRow extends { id: string }>({
  service,
  createSchema,
  updateSchema,
  label = service.resourceName,
  controller: overrides = {},
  reorderable = true,
  extend,
}: CrudRouterOptions<TRow>): Router {
  const router = Router()
  const controller: CrudController = { ...createCrudController(service, label), ...overrides }

  // Mutations always run: authenticate -> authorize -> validate.
  const guard: RequestHandler[] = [authenticate, authorizeContentManager]

  router.get('/', validate({ query: searchQuerySchema }), controller.listPublic)
  router.get('/admin', ...guard, validate({ query: searchQuerySchema }), controller.listAll)

  if (reorderable) {
    router.patch('/reorder', ...guard, validate({ body: reorderSchema }), controller.reorder)
  }

  // Resource-specific routes must be registered before '/:id' so that a literal
  // path segment is never swallowed by the id parameter.
  extend?.(router, { controller, service, guard })

  router.post('/', ...guard, validate({ body: createSchema }), controller.create)

  router.get('/:id', validate({ params: idParamSchema }), controller.getById)
  router.put('/:id', ...guard, validate({ params: idParamSchema, body: updateSchema }), controller.update)
  router.patch('/:id', ...guard, validate({ params: idParamSchema, body: updateSchema }), controller.update)
  router.delete('/:id', ...guard, validate({ params: idParamSchema }), controller.remove)

  return router
}

export default createCrudRouter
