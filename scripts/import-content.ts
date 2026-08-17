/**
 * Content import CLI — the Prisma replacement for the ad-hoc Supabase publish
 * scripts (seed-blog-posts, publish-july-blogs, publish-keyword-blogs,
 * seed-case-studies, seed-marketing-blog-posts, ...).
 *
 * Those scripts were near-identical copies of "read a data module, upsert by
 * slug", so they collapse into one parameterised command.
 *
 * Usage:
 *   npm run content:list
 *   npm run content:import -- --source=july-blogs
 *   npm run content:import -- --source=july-blogs --publish
 *   npm run content:import -- --source=all --dry-run
 */

import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import dotenv from 'dotenv'

import { ROOT_DIR } from '../src/config/env.js'
import { CONTENT_SOURCES, loadFrontendData, type ContentSourceType } from '../prisma/frontend-data.js'
import {
  importBlogPosts,
  importCaseStudies,
  importTeamMembers,
  type ImportOptions,
  type ImportResult,
  type SourceRecord,
} from '../prisma/importers.js'

dotenv.config({ path: path.join(ROOT_DIR, '.env') })

const prisma = new PrismaClient()

interface CliArgs {
  source: string
  publish: boolean
  dryRun: boolean
  list: boolean
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { source: 'all', publish: false, dryRun: false, list: false }

  for (const arg of argv.slice(2)) {
    if (arg === '--publish') args.publish = true
    else if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--list') args.list = true
    else if (arg.startsWith('--source=')) args.source = arg.slice('--source='.length)
  }

  return args
}

const IMPORTERS: Record<ContentSourceType, (rows: SourceRecord[], options: ImportOptions) => Promise<ImportResult>> = {
  blog: (rows, options) => importBlogPosts(prisma, rows, options),
  caseStudy: (rows, options) => importCaseStudies(prisma, rows, options),
  teamMember: (rows, options) => importTeamMembers(prisma, rows, options),
}

async function importSource(key: string, args: CliArgs): Promise<void> {
  const source = CONTENT_SOURCES[key]
  if (!source) throw new Error(`Unknown source "${key}". Run with --list to see the options.`)

  const rows = await loadFrontendData<SourceRecord>(source.file, source.exportName)

  if (rows.length === 0) {
    console.log(`  - ${key}: no records found in ${source.file} — skipped`)
    return
  }

  const result = await IMPORTERS[source.type](rows, { dryRun: args.dryRun, forcePublish: args.publish })
  const verb = args.dryRun ? 'would be' : ''

  console.log(`  - ${key}: ${result.created} ${verb} created, ${result.updated} ${verb} updated (${result.total} total)`)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv)

  if (args.list) {
    console.log('\nAvailable content sources:\n')
    for (const [key, source] of Object.entries(CONTENT_SOURCES)) {
      console.log(`  ${key.padEnd(16)} ${source.file} -> ${source.type}`)
    }
    console.log('\n  all              every source above\n')
    return
  }

  const keys = args.source === 'all' ? Object.keys(CONTENT_SOURCES) : [args.source]

  console.log(`\nImporting content${args.dryRun ? ' (dry run)' : ''}${args.publish ? ' (forcing published)' : ''}...\n`)

  for (const key of keys) {
    await importSource(key, args)
  }

  console.log('\nImport complete.\n')
}

main()
  .catch((error: unknown) => {
    console.error('\nImport failed:', error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(() => {
    void prisma.$disconnect()
  })
