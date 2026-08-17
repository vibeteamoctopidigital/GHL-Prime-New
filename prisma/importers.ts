import type { Prisma, PrismaClient } from '@prisma/client'

/**
 * Row mappers + upserters shared by `prisma/seed.ts` and
 * `scripts/import-content.ts`.
 *
 * These replace the one-off Supabase publish scripts that used to live in
 * ghlprime-example/scripts (seed-blog-posts, publish-july-blogs,
 * publish-keyword-blogs, seed-case-studies, ...). All of them did the same
 * thing — read a frontend data module and upsert it by slug — so it is
 * expressed once here and parameterised instead.
 */

/** The loose shape of a record in the frontend's data modules. */
export type SourceRecord = Record<string, unknown>

export interface ImportOptions {
  dryRun?: boolean
  forcePublish?: boolean
}

export interface ImportResult {
  created: number
  updated: number
  total: number
}

const str = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text === '' ? null : text
}

const toDate = (value: unknown): Date | null => {
  if (!value) return null
  const parsed = new Date(value as string)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

const num = (value: unknown, fallback: number | null = null): number | null =>
  Number.isFinite(Number(value)) ? Number(value) : fallback

// ---------------------------------------------------------------------------
// Mappers: frontend data shape (snake_case) -> Prisma shape (camelCase)
// ---------------------------------------------------------------------------

/** Only maps columns the table actually has; presentation-only keys are dropped. */
export function mapCaseStudy(study: SourceRecord): Prisma.CaseStudyUpdateInput {
  return {
    title: String(study['title'] ?? ''),
    category: String(study['category'] ?? ''),
    subtitle: str(study['subtitle']),
    challenge: str(study['challenge']),
    solution: str(study['solution']),
    outcome: str(study['outcome']),
    excerpt: str(study['excerpt']),
    image: str(study['image']),
    accent: str(study['accent']) ?? 'emerald',
    body: (Array.isArray(study['body']) ? study['body'] : []) as Prisma.InputJsonValue,
    featured: Boolean(study['featured']),
    published: study['published'] !== false,
  }
}

export function mapBlogPost(post: SourceRecord, { forcePublish = false }: ImportOptions = {}): Prisma.BlogPostUpdateInput {
  const published = forcePublish ? true : post['published'] !== false
  const publishedAt = toDate(post['published_at'])

  return {
    title: String(post['title'] ?? ''),
    category: String(post['category'] ?? ''),
    tags: Array.isArray(post['tags']) ? (post['tags'] as string[]) : [],
    author: str(post['author']) ?? 'GHL Prime Team',
    excerpt: str(post['excerpt']),
    coverImage: str(post['cover_image']),
    readingTime: num(post['reading_time']),
    content: str(post['content']),
    seoTitle: str(post['seo_title']),
    seoDescription: str(post['seo_description']),
    seoKeywords: str(post['seo_keywords']),
    featured: Boolean(post['featured']),
    published,
    // Publishing without an explicit date stamps "now", matching blogApi.js.
    publishedAt: publishedAt ?? (published ? new Date() : null),
  }
}

export function mapTeamMember(member: SourceRecord): Prisma.TeamMemberCreateInput {
  return {
    name: String(member['name'] ?? ''),
    role: String(member['role'] ?? ''),
    description: str(member['description']),
    imageUrl: str(member['image_url']),
    sortOrder: num(member['sort_order'], 999) ?? 999,
    linkedinUrl: str(member['linkedin_url']),
    facebookUrl: str(member['facebook_url']),
    instagramUrl: str(member['instagram_url']),
    twitterUrl: str(member['twitter_url']),
    upworkUrl: str(member['upwork_url']),
    websiteUrl: str(member['website_url']),
  }
}

// ---------------------------------------------------------------------------
// Upserters
// ---------------------------------------------------------------------------

/** Minimal delegate shape the upserters need. */
interface SlugDelegate {
  findUnique(args: { where: { slug: string }; select: { id: true } }): Promise<{ id: string } | null>
  upsert(args: { where: { slug: string }; update: unknown; create: unknown }): Promise<unknown>
}

interface FieldDelegate {
  findFirst(args: { where: Record<string, unknown>; select: { id: true } }): Promise<{ id: string } | null>
  update(args: { where: { id: string }; data: unknown }): Promise<unknown>
  create(args: { data: unknown }): Promise<unknown>
}

/** Upserts rows on the unique `slug` column. */
async function upsertBySlug(
  model: SlugDelegate,
  rows: SourceRecord[],
  mapRow: (row: SourceRecord) => Record<string, unknown>,
  { dryRun = false }: ImportOptions = {},
): Promise<ImportResult> {
  let created = 0
  let updated = 0

  for (const row of rows) {
    const slug = str(row['slug'])
    if (!slug) continue

    const exists = await model.findUnique({ where: { slug }, select: { id: true } })

    if (!dryRun) {
      const data = mapRow(row)
      await model.upsert({ where: { slug }, update: data, create: { ...data, slug } })
    }

    exists ? (updated += 1) : (created += 1)
  }

  return { created, updated, total: created + updated }
}

/** Upserts rows that have no unique key, matching on a chosen field. */
export async function upsertByField<T extends Record<string, unknown>>(
  model: FieldDelegate,
  rows: T[],
  field: keyof T & string,
  { dryRun = false }: ImportOptions = {},
): Promise<ImportResult> {
  let created = 0
  let updated = 0

  for (const row of rows) {
    const existing = await model.findFirst({ where: { [field]: row[field] }, select: { id: true } })

    if (!dryRun) {
      if (existing) await model.update({ where: { id: existing.id }, data: row })
      else await model.create({ data: row })
    }

    existing ? (updated += 1) : (created += 1)
  }

  return { created, updated, total: created + updated }
}

export const importCaseStudies = (prisma: PrismaClient, rows: SourceRecord[], options?: ImportOptions): Promise<ImportResult> =>
  upsertBySlug(prisma.caseStudy as unknown as SlugDelegate, rows, mapCaseStudy, options)

export const importBlogPosts = (prisma: PrismaClient, rows: SourceRecord[], options: ImportOptions = {}): Promise<ImportResult> =>
  upsertBySlug(prisma.blogPost as unknown as SlugDelegate, rows, (post) => mapBlogPost(post, options), options)

export const importTeamMembers = (prisma: PrismaClient, rows: SourceRecord[], options?: ImportOptions): Promise<ImportResult> =>
  upsertByField(prisma.teamMember as unknown as FieldDelegate, rows.map(mapTeamMember), 'name', options)
