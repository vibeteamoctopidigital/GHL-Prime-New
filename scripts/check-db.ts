/**
 * Database connection doctor.
 *
 * Validates the connection strings, proves the database is reachable, reports
 * which tables exist, and — on Supabase — checks that the PostgREST door is
 * actually shut (see prisma/supabase-setup.sql).
 *
 *   npm run db:check
 */

import { PrismaClient } from '@prisma/client'
import env from '../src/config/env.js'

const prisma = new PrismaClient()

let warnings = 0
let errors = 0

const ok = (msg: string) => console.log(`  ✓ ${msg}`)
const warn = (msg: string) => {
  warnings += 1
  console.log(`  ! ${msg}`)
}
const fail = (msg: string) => {
  errors += 1
  console.log(`  ✗ ${msg}`)
}

/** Splits a Postgres URL into its parts without ever printing the password. */
function describe(rawUrl: string): { host: string; port: string; database: string; params: URLSearchParams } | null {
  try {
    const url = new URL(rawUrl)
    return {
      host: url.hostname,
      port: url.port || '5432',
      database: url.pathname.replace(/^\//, ''),
      params: url.searchParams,
    }
  } catch {
    return null
  }
}

const isSupabase = (host: string): boolean => host.includes('supabase.co') || host.includes('supabase.com')
const isPooler = (host: string, port: string): boolean => host.includes('pooler') && port === '6543'

console.log('\n═══ Connection strings ═══\n')

const runtime = describe(env.DATABASE_URL)
const direct = env.DIRECT_URL ? describe(env.DIRECT_URL) : null

if (!runtime) {
  fail('DATABASE_URL is not a valid Postgres URL')
} else {
  console.log(`  DATABASE_URL → ${runtime.host}:${runtime.port}/${runtime.database}`)

  const provider = isSupabase(runtime.host) ? 'Supabase' : runtime.host.includes('neon.tech') ? 'Neon' : 'PostgreSQL'
  ok(`provider looks like ${provider}`)

  if (isSupabase(runtime.host)) {
    if (runtime.port === '6543') {
      ok('runtime uses the transaction pooler (6543) — correct for serverless')

      // Prisma keeps prepared statements unless told otherwise, and the
      // transaction pooler cannot hold them across statements.
      if (runtime.params.get('pgbouncer') === 'true') {
        ok('pgbouncer=true is set')
      } else {
        fail('pgbouncer=true is MISSING on DATABASE_URL — Prisma will fail intermittently with "prepared statement already exists"')
      }

      if (runtime.params.get('connection_limit')) ok(`connection_limit=${runtime.params.get('connection_limit')}`)
      else warn('connection_limit is not set; connection_limit=1 is recommended for serverless')
    } else {
      warn(`runtime is on port ${runtime.port}, not the 6543 transaction pooler — fine for a long-lived server, risky for serverless`)
    }
  }
}

if (!direct) {
  warn('DIRECT_URL is not set — migrations will fall back to DATABASE_URL, which fails on a transaction pooler')
} else {
  console.log(`  DIRECT_URL   → ${direct.host}:${direct.port}/${direct.database}`)

  if (direct.port === '6543') {
    fail('DIRECT_URL points at the transaction pooler (6543). Migrations need a session connection — use port 5432')
  } else {
    ok('DIRECT_URL uses a session connection — correct for migrations')
  }
}

console.log('\n═══ Connectivity ═══\n')

try {
  const started = Date.now()
  const [version] = await prisma.$queryRaw<{ version: string }[]>`SELECT version()`
  ok(`connected in ${Date.now() - started}ms`)
  console.log(`    ${version?.version.split(',')[0] ?? 'unknown version'}`)
} catch (error) {
  fail(`cannot reach the database: ${error instanceof Error ? error.message : String(error)}`)
  await prisma.$disconnect()
  console.log('\nFix the connection string before continuing.\n')
  process.exit(1)
}

console.log('\n═══ Schema ═══\n')

const EXPECTED_TABLES = [
  'users', 'refresh_tokens', 'case_studies', 'case_study_team_members',
  'team_members', 'team_page_members', 'blog_posts', 'partner_logos',
  'technology_logos', 'meeting_gallery', 'gallery_categories', 'gallery_images',
  'showcase_items', 'showcase_stats', 'showcase_placements',
  'contact_leads', 'service_surveys', 'media_assets',
]

const tables = await prisma.$queryRaw<{ tablename: string }[]>`
  SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
`
const found = new Set(tables.map((row) => row.tablename))
const missing = EXPECTED_TABLES.filter((name) => !found.has(name))

if (missing.length === 0) {
  ok(`all ${EXPECTED_TABLES.length} tables present`)
} else {
  fail(`${missing.length} table(s) missing: ${missing.join(', ')} — run: npx prisma db push`)
}

const extra = [...found].filter((name) => !EXPECTED_TABLES.includes(name) && !name.startsWith('_prisma'))
if (extra.length > 0) warn(`extra tables not owned by this schema: ${extra.join(', ')}`)

console.log('\n═══ Row counts ═══\n')

const [users, caseStudies, blogPosts, leads, surveys, media] = await Promise.all([
  prisma.user.count(),
  prisma.caseStudy.count(),
  prisma.blogPost.count(),
  prisma.contactLead.count(),
  prisma.serviceSurvey.count(),
  prisma.mediaAsset.count(),
])

console.log(`  users ${users} · case studies ${caseStudies} · blog posts ${blogPosts}`)
console.log(`  contact leads ${leads} · service surveys ${surveys} · media assets ${media}`)

if (users === 0) warn('no admin user exists yet — run: npm run db:seed')
else ok('at least one user exists')

// ---------------------------------------------------------------------------
// Supabase-only: confirm the auto-generated PostgREST API cannot read our data
// ---------------------------------------------------------------------------
if (runtime && isSupabase(runtime.host)) {
  console.log('\n═══ Supabase exposure check ═══\n')

  const exposed = await prisma.$queryRaw<{ table_name: string; grantee: string }[]>`
    SELECT DISTINCT table_name, grantee
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')
    ORDER BY table_name
  `

  if (exposed.length === 0) {
    ok('no anon/authenticated grants — PostgREST cannot reach these tables')
  } else {
    const names = [...new Set(exposed.map((row) => row.table_name))]
    fail(
      `${names.length} table(s) are still readable through Supabase's public REST API ` +
        `using the anon key: ${names.slice(0, 6).join(', ')}${names.length > 6 ? '…' : ''}`,
    )
    console.log('    Run prisma/supabase-setup.sql in the Supabase SQL editor to close this.')
  }

  const noRls = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND rowsecurity = false
  `
  if (noRls.length === 0) ok('row level security enabled on every table (defence in depth)')
  else warn(`${noRls.length} table(s) without RLS: ${noRls.map((r) => r.tablename).join(', ')}`)
}

await prisma.$disconnect()

console.log(`\n${'═'.repeat(60)}`)
console.log(`  ${errors} error(s), ${warnings} warning(s)`)
console.log('═'.repeat(60) + '\n')

process.exit(errors > 0 ? 1 : 0)
