import 'dotenv/config'
import { defineConfig, env } from 'prisma/config'

/**
 * Prisma 7 moved connection config out of schema.prisma's datasource block
 * and into this file. Used by the CLI only (introspection, migrate) — the
 * running app never reads this, it builds its own connection via
 * @prisma/adapter-pg in src/config/prisma.ts. Both read the same
 * DATABASE_URL — there's no separate pooled/direct split here since this
 * targets a plain Postgres connection, not a transaction-mode pgbouncer
 * pooler (which needs a distinct non-pooled URL for session-level features
 * introspection/migrate rely on). If a future deployment sits behind that
 * kind of pooler again, reintroduce a DIRECT_URL and point this at it.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: env('DATABASE_URL'),
  },
})
