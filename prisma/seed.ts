/**
 * Idempotent database seed.
 *
 * Every record is upserted on a natural key (slug / name / label), so running
 * this repeatedly converges to the same state instead of duplicating rows.
 *
 *   npm run db:seed
 *
 * Content is imported directly from the frontend's data modules where they
 * exist, so the seeded database matches the site's static fallback content.
 */

import path from 'node:path'
import { PrismaClient, UserRole } from '@prisma/client'
import bcrypt from 'bcryptjs'
import dotenv from 'dotenv'

import { ROOT_DIR } from '../src/config/env.js'
import { importBlogPosts, importCaseStudies, importTeamMembers, upsertByField, type ImportResult } from './importers.js'
import { loadFrontendData } from './frontend-data.js'
import {
  GALLERY_CATEGORY_SEED,
  GALLERY_IMAGE_SEED,
  MEETING_GALLERY_SEED,
  PARTNER_LOGO_SEED,
  SHOWCASE_ITEM_SEED,
  SHOWCASE_STAT_SEED,
  TECHNOLOGY_LOGO_SEED,
} from './seed-data.js'

dotenv.config({ path: path.join(ROOT_DIR, '.env') })

const prisma = new PrismaClient()

const summarize = (result: ImportResult): string => `${result.created} created, ${result.updated} updated`

// ---------------------------------------------------------------------------
// Seeders
// ---------------------------------------------------------------------------

async function seedAdminUser(): Promise<string> {
  const email = (process.env['SEED_ADMIN_EMAIL'] ?? 'admin@ghlprime.com').toLowerCase()
  const password = process.env['SEED_ADMIN_PASSWORD'] ?? 'Admin@12345'

  if (await prisma.user.findUnique({ where: { email } })) return `${email} (already exists)`

  await prisma.user.create({
    data: {
      email,
      passwordHash: await bcrypt.hash(password, 12),
      fullName: process.env['SEED_ADMIN_NAME'] ?? 'GHL Prime Admin',
      role: UserRole.ADMIN,
    },
  })

  return `${email} / ${password} (created)`
}

async function seedCaseStudies(): Promise<string> {
  const studies = await loadFrontendData('caseStudies.js', 'caseStudies')
  if (studies.length === 0) return 'skipped (no frontend data)'
  return summarize(await importCaseStudies(prisma, studies))
}

async function seedBlogPosts(): Promise<string> {
  // blogPosts already includes keywordBlogPosts; julyBlogPosts is a separate
  // batch that the old publish-july-blogs.mjs pushed independently.
  const [posts, julyPosts] = await Promise.all([
    loadFrontendData('blogPosts.js', 'blogPosts'),
    loadFrontendData('julyBlogPosts.js', 'julyBlogPosts'),
  ])

  const all = [...posts, ...julyPosts]
  if (all.length === 0) return 'skipped (no frontend data)'

  return summarize(await importBlogPosts(prisma, all))
}

async function seedTeamMembers(): Promise<string> {
  const members = await loadFrontendData('teamMembers.js', 'teamMembers')
  if (members.length === 0) return 'skipped (no frontend data)'
  return summarize(await importTeamMembers(prisma, members))
}

async function seedPartnerLogos(): Promise<string> {
  return summarize(await upsertByField(prisma.partnerLogo as never, PARTNER_LOGO_SEED, 'companyName'))
}

async function seedTechnologyLogos(): Promise<string> {
  return summarize(await upsertByField(prisma.technologyLogo as never, TECHNOLOGY_LOGO_SEED, 'name'))
}

async function seedMeetingGallery(): Promise<string> {
  return summarize(await upsertByField(prisma.meetingGalleryItem as never, MEETING_GALLERY_SEED, 'imageUrl'))
}

async function seedGallery(): Promise<string> {
  for (const category of GALLERY_CATEGORY_SEED) {
    await prisma.galleryCategory.upsert({
      where: { slug: category.slug },
      update: { name: category.name, sortOrder: category.sortOrder },
      create: category,
    })
  }

  for (const { categorySlug, ...image } of GALLERY_IMAGE_SEED) {
    const category = await prisma.galleryCategory.findUnique({ where: { slug: categorySlug } })
    const payload = { ...image, categoryId: category?.id ?? null }

    const existing = await prisma.galleryImage.findFirst({ where: { imageUrl: image.imageUrl } })

    if (existing) await prisma.galleryImage.update({ where: { id: existing.id }, data: payload })
    else await prisma.galleryImage.create({ data: payload })
  }

  return `${GALLERY_CATEGORY_SEED.length} categories, ${GALLERY_IMAGE_SEED.length} images`
}

async function seedShowcase(): Promise<string> {
  await upsertByField(prisma.showcaseStat as never, SHOWCASE_STAT_SEED, 'label')

  for (const { placements, ...item } of SHOWCASE_ITEM_SEED) {
    const existing = await prisma.showcaseItem.findFirst({ where: { originName: item.originName } })

    const record = existing
      ? await prisma.showcaseItem.update({ where: { id: existing.id }, data: item })
      : await prisma.showcaseItem.create({ data: item })

    for (const placement of placements) {
      await prisma.showcasePlacement.upsert({
        where: { itemId_pageKey: { itemId: record.id, pageKey: placement.pageKey } },
        update: { sortOrder: placement.sortOrder, enabled: true },
        create: { itemId: record.id, ...placement },
      })
    }
  }

  return `${SHOWCASE_ITEM_SEED.length} items, ${SHOWCASE_STAT_SEED.length} stats`
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  /**
   * `--admin-only` creates the login account and touches nothing else.
   *
   * Use it against a database that already holds real content. The content
   * seeders below upsert by slug from the frontend data modules, which would
   * overwrite a post that has since been edited in the admin panel — fine for a
   * fresh database, destructive for a populated one.
   */
  const adminOnly = process.argv.includes('--admin-only')
  const force = process.argv.includes('--force')

  /**
   * Refuse to overwrite a populated database.
   *
   * The content seeders upsert BY SLUG from the frontend data modules. Against
   * the live Supabase project — 50 blog posts, 17 case studies — that would
   * silently replace anything since edited in the admin panel with an older
   * copy. Losing edits is not something a seed script should be able to do by
   * accident, so it has to be asked for explicitly.
   */
  if (!adminOnly && !force) {
    const [existingPosts, existingStudies] = await Promise.all([
      prisma.blogPost.count(),
      prisma.caseStudy.count(),
    ])

    if (existingPosts > 0 || existingStudies > 0) {
      console.error(
        `\nRefusing to seed: this database already holds content ` +
          `(${existingPosts} blog posts, ${existingStudies} case studies).\n\n` +
          `  The content seeders upsert by slug and would overwrite live edits.\n\n` +
          `  • To create only the admin login:  npm run db:seed:admin\n` +
          `  • To overwrite anyway (destructive): npm run db:seed -- --force\n`,
      )
      process.exitCode = 1
      return
    }
  }

  console.log(`\nSeeding GHL Prime database${adminOnly ? ' (admin user only)' : ''}...\n`)

  const contentSteps: [string, () => Promise<string>][] = [
    ['Case studies', seedCaseStudies],
    ['Blog posts', seedBlogPosts],
    ['Team members', seedTeamMembers],
    ['Partner logos', seedPartnerLogos],
    ['Technology logos', seedTechnologyLogos],
    ['Meeting gallery', seedMeetingGallery],
    ['Gallery', seedGallery],
    ['Showcase', seedShowcase],
  ]

  const steps: [string, () => Promise<string>][] = adminOnly
    ? [['Admin user', seedAdminUser]]
    : [['Admin user', seedAdminUser], ...contentSteps]

  for (const [label, run] of steps) {
    console.log(`✔ ${label} — ${await run()}`)
  }

  if (adminOnly) {
    console.log('\nSkipped all content seeders — existing content left untouched.')
  }

  console.log('\nSeed complete.\n')
}

main()
  .catch((error: unknown) => {
    console.error('\nSeed failed:', error)
    process.exitCode = 1
  })
  .finally(() => {
    void prisma.$disconnect()
  })
