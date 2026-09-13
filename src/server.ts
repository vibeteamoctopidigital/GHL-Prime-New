import type { Server } from 'node:http'
import env from './config/env.js'
import { API_PREFIX } from './config/constants.js'
import { connectDatabase, disconnectDatabase } from './config/prisma.js'
import { reportCloudinaryStatus } from './config/cloudinary.js'
import logger from './shared/utils/logger.js'
import createApp from './app.js'
import { initBlogAiScheduler } from './modules/blog-ai/blogAi.scheduler.js'

async function bootstrap(): Promise<Server> {
  await connectDatabase()
  reportCloudinaryStatus()

  // Best-effort: Auto Blog's daily schedule is a non-critical background
  // feature — a hiccup loading its settings on boot must never take down
  // the whole API. Once running, saving settings re-arms it anyway (see
  // blogAi.controller.ts), so a failed boot-time load is recoverable.
  try {
    await initBlogAiScheduler()
  } catch (error) {
    logger.error('Blog AI scheduler failed to initialize — Auto Blog will not run on schedule until settings are re-saved:', error)
  }

  const app = createApp()

  const server = app.listen(env.PORT, () => {
    logger.info(`GHL Prime API listening on http://localhost:${env.PORT}${API_PREFIX}`)
    logger.info(`Environment: ${env.NODE_ENV}`)
    logger.info(`Allowed origins: ${env.corsOrigins.join(', ') || '(none)'}`)
  })

  /** Stop accepting connections, finish in-flight requests, then close the pool. */
  const shutdown = (signal: string): void => {
    logger.info(`${signal} received — shutting down gracefully`)

    server.close(() => {
      void disconnectDatabase().finally(() => process.exit(0))
    })

    // Don't let a hung connection block the shutdown forever.
    setTimeout(() => {
      logger.error('Forced shutdown after timeout')
      process.exit(1)
    }, 10_000).unref()
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection:', reason)
  })

  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception:', error)
    process.exit(1)
  })

  return server
}

bootstrap().catch((error: unknown) => {
  logger.error('Failed to start server:', error)
  process.exit(1)
})
