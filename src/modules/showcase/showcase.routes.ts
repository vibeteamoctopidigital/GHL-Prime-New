import { Router } from 'express'
import createCrudRouter from '../../shared/factories/createCrudRouter.js'
import createModuleIndex from '../../shared/factories/createModuleIndex.js'
import validate from '../../shared/middleware/validate.js'
import asyncHandler from '../../shared/utils/asyncHandler.js'
import { sendOk } from '../../shared/utils/ApiResponse.js'
import { showcaseItemService, showcaseStatService } from './showcase.service.js'
import {
  createShowcaseItemSchema,
  createShowcaseStatSchema,
  pageKeyParamSchema,
  updateShowcaseItemSchema,
  updateShowcaseStatSchema,
} from './showcase.validators.js'

const itemsRouter = createCrudRouter({
  service: showcaseItemService,
  label: 'Showcase item',
  createSchema: createShowcaseItemSchema,
  updateSchema: updateShowcaseItemSchema,
  extend: (router) => {
    /** GET /showcase/items/page/home — what the homepage section renders. */
    router.get(
      '/page/:pageKey',
      validate({ params: pageKeyParamSchema }),
      asyncHandler(async (req, res) => {
        const data = await showcaseItemService.listForPage(req.params['pageKey'] as string)
        return sendOk(res, data, 'Showcase items retrieved')
      }),
    )
  },
})

const statsRouter = createCrudRouter({
  service: showcaseStatService,
  label: 'Showcase stat',
  createSchema: createShowcaseStatSchema,
  updateSchema: updateShowcaseStatSchema,
})

const router = Router()

/** GET /showcase — lists what lives under this prefix. */
router.get(
  '/',
  createModuleIndex('/showcase', [
    { method: 'GET', path: '/page/:pageKey', description: 'Items + stats for a page ("home" or "service:<slug>")' },
    { method: 'GET', path: '/items', description: 'Shipped-Evidence cards' },
    { method: 'GET', path: '/items/page/:pageKey', description: 'Items placed on a page' },
    { method: 'GET', path: '/items/admin', description: 'All items including unpublished (auth)' },
    { method: 'GET', path: '/stats', description: 'Stat-bar tiles' },
    { method: 'GET', path: '/stats/admin', description: 'All stats including unpublished (auth)' },
  ]),
)

router.use('/items', itemsRouter)
router.use('/stats', statsRouter)

/** One call for a whole page's showcase section: paired cards + stat bar. */
router.get(
  '/page/:pageKey',
  validate({ params: pageKeyParamSchema }),
  asyncHandler(async (req, res) => {
    const [items, stats] = await Promise.all([
      showcaseItemService.listForPage(req.params['pageKey'] as string),
      showcaseStatService.listPublic(),
    ])

    return sendOk(res, { items, stats }, 'Showcase retrieved')
  }),
)

export default router
