import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import dotenv from 'dotenv'
import logger from '../shared/utils/logger.js'

// Load .env BEFORE the pg adapter below reads process.env.DATABASE_URL.
// This file used to rely on its importer importing config/env.js first, but
// ES module imports are hoisted: seed.ts, blog-watch.ts and the other
// scripts here import prisma.js on an earlier line, so the adapter was
// constructed with DATABASE_URL undefined and every standalone script died
// with "SASL: client password must be a string". dotenv is idempotent, so
// the server's own env.js import is unaffected.
/**
 * Walks up from this module until it finds a .env, the same way env.ts finds
 * the package root. A fixed '../../' would land in `dist/` once compiled, and
 * `new URL(...).pathname` percent-encodes spaces — which silently left the
 * adapter with an undefined DATABASE_URL on any project path containing one.
 */
function findEnvFile(startDir: string): string | undefined {
  let dir = startDir

  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(dir, '.env')
    if (existsSync(candidate)) return candidate

    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  return undefined
}

dotenv.config({ path: findEnvFile(path.dirname(fileURLToPath(import.meta.url))) })

/**
 * Prisma Client, connected via the @prisma/adapter-pg driver adapter —
 * Prisma 7 requires an explicit adapter for a direct database connection
 * (schema.prisma's old datasource `url`/`directUrl` fields no longer work
 * at runtime, only `prisma.config.ts`, which the CLI reads for
 * introspection/migrate). DATABASE_URL is the pooled (pgbouncer
 * transaction-mode) connection string — correct for a normal request-driven
 * app; DIRECT_URL is only for the CLI, never read here.
 *
 * Same singleton-on-globalThis guard `config/supabase.ts` used, for the same
 * reason: `tsx watch`'s hot reload (and, previously, this same pattern
 * protecting the Supabase client) must not accumulate a new client — and
 * therefore a new connection pool — on every file save.
 */
const globalForPrisma = globalThis as typeof globalThis & { __ghlPrisma?: PrismaClient }

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })

export const prisma: PrismaClient = globalForPrisma.__ghlPrisma ?? new PrismaClient({ adapter })
globalForPrisma.__ghlPrisma = prisma

/** Proves the database is reachable and the connection string is accepted. */
export async function connectDatabase(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`
  logger.info('Prisma connected')
}

/** Closes the connection pool — was a no-op under Supabase/PostgREST (stateless HTTP); now a real pool to release. */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect()
  logger.info('Prisma disconnected')
}

export default prisma
