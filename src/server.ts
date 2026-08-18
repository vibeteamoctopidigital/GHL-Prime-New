import type { Server } from 'node:http'
import env from './config/env.js'
import { connectDatabase, disconnectDatabase } from './config/supabase.js'
import { reportCloudinaryStatus } from './config/cloudinary.js'
import logger from './shared/utils/logger.js'
import createApp from './app.js'

async function bootstrap(): Promise<Server> {
  await connectDatabase()
  reportCloudinaryStatus()

  const app = createApp()

  const server = app.listen(env.PORT, () => {
    logger.info(`GHL Prime API listening on http://localhost:${env.PORT}${env.API_PREFIX}`)
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
