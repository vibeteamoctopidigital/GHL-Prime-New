import express, { type Express } from 'express'
import cors from 'cors'
import helmet from 'helmet'
import compression from 'compression'
import cookieParser from 'cookie-parser'
import morgan from 'morgan'

import env from './config/env.js'
import { API_PREFIX, HTTP_STATUS } from './config/constants.js'
import apiRoutes from './routes/index.js'
import { apiLimiter } from './shared/middleware/rateLimiter.js'
import errorHandler, { notFound } from './shared/middleware/errorHandler.js'
import ApiError from './shared/utils/ApiError.js'
import asyncHandler from './shared/utils/asyncHandler.js'
import logger from './shared/utils/logger.js'
import sitemapService from './modules/sitemap/sitemap.service.js'

export function createApp(): Express {
  const app = express()

  // Behind Vercel/Nginx: makes req.ip and rate limiting see the real client IP.
  app.set('trust proxy', 1)
  app.disable('x-powered-by')

  // --- Security & parsing ---------------------------------------------------
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }))

  app.use(
    cors({
      origin(origin, callback) {
        // No origin = same-origin, curl, or a server-to-server call.
        if (!origin) return callback(null, true)
        if (env.corsOrigins.includes(origin) || env.corsOrigins.includes('*')) return callback(null, true)
        return callback(ApiError.forbidden(`Origin ${origin} is not allowed by CORS`))
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    }),
  )

  app.use(express.json({ limit: '2mb' }))
  app.use(express.urlencoded({ extended: true, limit: '2mb' }))
  app.use(cookieParser())
  app.use(compression())

  if (!env.isTest) {
    app.use(
      morgan(env.isProduction ? 'combined' : 'dev', {
        stream: { write: (line: string) => logger.info(line.trim()) },
      }),
    )
  }

  // --- API ------------------------------------------------------------------
  app.use(API_PREFIX, apiLimiter, apiRoutes)

  // Root banner.
  app.get('/', (_req, res) => {
    res.json({ success: true, message: 'GHL Prime API is running', data: { docs: API_PREFIX } })
  })

  // --- Compatibility routes -------------------------------------------------
  // The frontend and the old vercel.json still call these paths.
  app.get(
    '/sitemap.xml',
    asyncHandler(async (_req, res) => {
      res.setHeader('Content-Type', 'application/xml; charset=utf-8')
      res.send(await sitemapService.generateXml())
    }),
  )

  /** 410 Gone for retired URLs — ported from api/gone.js. */
  app.all('/free-scripts', (_req, res) => {
    res.status(HTTP_STATUS.GONE)
    res.setHeader('Cache-Control', 'public, max-age=86400')
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>410 Gone — GHL Prime</title>
  <meta name="robots" content="noindex" />
</head>
<body>
  <h1>410 Gone</h1>
  <p>This page has been permanently removed. Please visit <a href="${env.SITE_URL}/">ghlprime.com</a>.</p>
</body>
</html>`)
  })

  // --- Terminal handlers (order matters) ------------------------------------
  app.use(notFound)
  app.use(errorHandler)

  return app
}

export default createApp
