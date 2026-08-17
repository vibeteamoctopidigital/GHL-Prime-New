import { PrismaClient } from '@prisma/client'
import env from './env.js'
import logger from '../shared/utils/logger.js'

/**
 * A single PrismaClient for the whole process.
 *
 * The `globalThis` cache serves two purposes: it stops tsx's watch-mode reloads
 * from opening a new connection pool on every restart, and on serverless it
 * lets a warm invocation reuse the existing pool instead of opening another
 * connection per request — the classic way to exhaust a Postgres connection
 * limit from Lambda.
 */
const globalForPrisma = globalThis as typeof globalThis & {
  __ghlPrismaClient?: PrismaClient
}

export const prisma: PrismaClient =
  globalForPrisma.__ghlPrismaClient ??
  new PrismaClient({
    log: env.isDevelopment ? ['warn', 'error'] : ['error'],
  })

globalForPrisma.__ghlPrismaClient = prisma

export async function connectDatabase(): Promise<void> {
  await prisma.$connect()
  logger.info('PostgreSQL connected via Prisma')
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect()
  logger.info('PostgreSQL disconnected')
}

export default prisma
