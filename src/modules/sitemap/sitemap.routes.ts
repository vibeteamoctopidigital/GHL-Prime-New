import { Router, type RequestHandler } from 'express'
import env from '../../config/env.js'
import asyncHandler from '../../shared/utils/asyncHandler.js'
import ApiError from '../../shared/utils/ApiError.js'
import { sendOk } from '../../shared/utils/ApiResponse.js'
import sitemapService from './sitemap.service.js'

const router = Router()

/**
 * Optional shared-secret guard, ported from the old serverless function: when
 * SITEMAP_REFRESH_TOKEN is set, the caller must present it.
 */
const requireSitemapToken: RequestHandler = (req, _res, next) => {
  const required = env.SITEMAP_REFRESH_TOKEN
  if (!required) return next()

  const header = req.headers.authorization ?? ''
  const provided = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : req.headers['x-sitemap-token']

  if (provided !== required) return next(ApiError.unauthorized('Invalid sitemap refresh token'))
  return next()
}

/** POST /sitemap/refresh — regenerates public/sitemap.xml. */
router.post(
  '/refresh',
  requireSitemapToken,
  asyncHandler(async (_req, res) => {
    const result = await sitemapService.refresh()
    return sendOk(res, result, 'Sitemap refreshed successfully')
  }),
)

/** GET /sitemap/xml — serves the sitemap directly, no disk write required. */
router.get(
  '/xml',
  asyncHandler(async (_req, res) => {
    const xml = await sitemapService.generateXml()
    res.setHeader('Content-Type', 'application/xml; charset=utf-8')
    return res.status(200).send(xml)
  }),
)

export default router
