import { Router } from 'express'
import authenticate from '../../shared/middleware/authenticate.js'
import { authorizeContentManager } from '../../shared/middleware/authorize.js'
import asyncHandler from '../../shared/utils/asyncHandler.js'
import { sendOk } from '../../shared/utils/ApiResponse.js'
import dashboardService from './dashboard.service.js'
import createModuleIndex from '../../shared/factories/createModuleIndex.js'

const router = Router()

/** GET /dashboard — lists what lives under this prefix. */
router.get('/', createModuleIndex('/dashboard', [
  {
    "method": "GET",
    "path": "/summary",
    "description": "Counts + recent activity"
  },
  {
    "method": "GET",
    "path": "/counts",
    "description": "Per-collection totals"
  },
  {
    "method": "GET",
    "path": "/recent",
    "description": "Recently touched records"
  }
]))

router.use(authenticate, authorizeContentManager)

/** GET /dashboard/summary — counts + recent activity in one call. */
router.get(
  '/summary',
  asyncHandler(async (_req, res) => {
    const [counts, recent] = await Promise.all([dashboardService.counts(), dashboardService.recent()])
    return sendOk(res, { counts, recent }, 'Dashboard summary retrieved')
  }),
)

router.get(
  '/counts',
  asyncHandler(async (_req, res) => {
    const data = await dashboardService.counts()
    return sendOk(res, data, 'Dashboard counts retrieved')
  }),
)

router.get(
  '/recent',
  asyncHandler(async (_req, res) => {
    const data = await dashboardService.recent()
    return sendOk(res, data, 'Recent activity retrieved')
  }),
)

export default router
