import { Router } from 'express'
import supabase from '../../config/supabase.js'
import env from '../../config/env.js'
import asyncHandler from '../../shared/utils/asyncHandler.js'
import { sendError, sendOk } from '../../shared/utils/ApiResponse.js'
import { HTTP_STATUS } from '../../config/constants.js'

const router = Router()
const startedAt = Date.now()

/** Liveness — answers as long as the process is up. */
router.get('/', (_req, res) => {
  sendOk(
    res,
    {
      ok: true,
      status: 'healthy',
      environment: env.NODE_ENV,
      uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
      timestamp: new Date().toISOString(),
    },
    'Service is healthy',
  )
})

/** Readiness — also proves Supabase round-trips. */
router.get(
  '/db',
  asyncHandler(async (_req, res) => {
    const start = Date.now()

    // head:true asks for the count only, so no rows cross the wire.
    const { error } = await supabase.from('case_studies').select('id', { head: true, count: 'exact' })

    if (error) {
      return sendError(res, {
        message: 'Database unreachable',
        statusCode: HTTP_STATUS.INTERNAL_SERVER_ERROR,
        errors: { reason: error.message },
      })
    }

    return sendOk(res, { ok: true, database: 'connected', latency_ms: Date.now() - start }, 'Database is reachable')
  }),
)

export default router
