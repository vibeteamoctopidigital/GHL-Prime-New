/**
 * Runs a .sql file against the database over DIRECT_URL (the session
 * connection — DDL cannot go through the transaction pooler).
 *
 *   npm run db:apply -- prisma/supabase-migrate.sql
 *
 * Used instead of `prisma db push` for the live database: push reconciles the
 * schema by dropping whatever it does not know about, whereas these scripts are
 * written to be additive and are reviewed before they run.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import env, { ROOT_DIR } from '../src/config/env.js'

const file = process.argv[2]

if (!file) {
  console.error('\nUsage: npm run db:apply -- <path-to.sql>\n')
  process.exit(1)
}

const fullPath = path.isAbsolute(file) ? file : path.join(ROOT_DIR, file)
const sql = readFileSync(fullPath, 'utf8')

const connectionString = env.DIRECT_URL ?? env.DATABASE_URL

if (connectionString.includes(':6543')) {
  console.error('\nDIRECT_URL points at the transaction pooler (6543); DDL needs the session connection (5432).\n')
  process.exit(1)
}

const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } })

console.log(`\nApplying ${path.basename(fullPath)}...\n`)

await client.connect()

try {
  const result = await client.query(sql)
  const results = Array.isArray(result) ? result : [result]

  // The scripts end with a verification SELECT; show whatever it returned.
  const lastRows = results.filter((r) => r?.rows?.length).pop()
  if (lastRows) console.table(lastRows.rows)

  console.log(`\n✔ Applied successfully (${results.length} statements).\n`)
} catch (error) {
  console.error(`\n✗ Failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  await client.end()
}
