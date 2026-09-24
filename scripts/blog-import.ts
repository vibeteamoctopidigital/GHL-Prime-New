/**
 * Import finished drafts from content/drafts/*.json into blog_posts.
 *
 *   npm run blog:import
 *
 * The writing happens in a Claude Code session; this script only moves the
 * finished JSON into Postgres. A post lands as a draft unless auto-publish is
 * switched on, and even then only if lib/audit.ts finds no errors in it and
 * every internal link points at a page that exists. Without a person reading
 * the draft, those checks are the only thing standing between a broken post
 * and a reader.
 *
 * Re-running is safe: a slug that already exists is updated in place, and an
 * already-published post is left alone entirely.
 */
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename } from 'node:fs/promises'
import path from 'node:path'
import prisma, { disconnectDatabase } from '../src/config/prisma.js'
import { ROOT_DIR } from '../src/config/env.js'
import { toSlug } from '../src/shared/utils/slug.js'
import sitemapService from '../src/modules/sitemap/sitemap.service.js'
import logger from '../src/shared/utils/logger.js'
import { autoPublishEnabled } from '../src/modules/blog-writer/blogWriter.store.js'
import { audit, countWords, stripTags } from '../src/modules/blog-writer/lib/audit.js'
import { CTA_VARIANT_IDS, RANDOM_CTA_VARIANT, pickRandomCtaVariant } from '../src/modules/blog-writer/lib/cta-variants.js'
import {
  applyInsertions,
  chooseSlots,
  findHeadingSlots,
  imageHtml,
  placeCtaSlot,
  queryForHeading,
  type SourceRef,
} from '../src/modules/blog-writer/lib/image-placement.js'
import { BLOG_CATEGORIES, DEFAULT_BLOG_CATEGORY, MAX_IMAGES, MIN_IMAGES, clampWords, readingTimeFor } from '../src/modules/blog-writer/lib/rules.js'
import { STATIC_ROUTE_SET, isOwnHost } from '../src/modules/blog-writer/lib/site.js'
import { fetchStockPhoto, isPexelsConfigured } from '../src/modules/blog-writer/lib/stock-photo.js'
import { CTA_MARKER, RESEARCH_MODES } from '../src/modules/blog-writer/lib/writing-standard.js'

const DRAFTS_DIR = path.join(ROOT_DIR, 'content', 'drafts')
const IMPORTED_DIR = path.join(DRAFTS_DIR, 'imported')

/** The shape a draft JSON file must have. Everything else on BlogPost has a default. */
type DraftFile = {
  title?: unknown
  slug?: unknown
  excerpt?: unknown
  content?: unknown
  category?: unknown
  tags?: unknown
  seoTitle?: unknown
  seoDescription?: unknown
  seoKeywords?: unknown
  targetKeyword?: unknown
  ctaVariant?: unknown
  imageCount?: unknown
  targetWords?: unknown
  sources?: unknown
  topicId?: unknown
  sourceUrl?: unknown
  sourceName?: unknown
  researchMode?: unknown
}

type Normalized = {
  title: string
  slug: string
  excerpt: string
  content: string
  category: string
  tags: string[]
  seoTitle: string
  seoDescription: string
  seoKeywords: string
  targetKeyword: string
  ctaVariant: string
  imageCount: number
  targetWords: number
  sources: SourceRef[]
  sourceUrl: string
  sourceName: string
  researchMode: string
  topicId: string
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map(asString).filter(Boolean)
}

/**
 * Validate one file and fill in what can be derived. Returns the problems
 * rather than throwing, so one malformed file reports its own fault and the
 * rest of the batch still imports.
 */
function normalize(file: DraftFile): { post?: Normalized; errors: string[] } {
  const errors: string[] = []

  const title = asString(file.title)
  const excerpt = asString(file.excerpt)
  const content = asString(file.content)

  if (!title) errors.push('missing `title`')
  if (!excerpt) errors.push('missing `excerpt`')
  if (!content) errors.push('missing `content`')

  // Derived rather than required: a slug is a mechanical function of the title.
  const slug = asString(file.slug) || toSlug(title)
  if (!slug) errors.push('could not derive a `slug` (is the title empty?)')

  if (content && /<(script|style|div|h1)\b/i.test(content)) {
    errors.push('`content` contains a disallowed tag (<script>, <style>, <div> or <h1>)')
  }

  // GHL Prime's blog requires a category on every post. Defaulted rather than
  // rejected when missing — a good post with no category is still a good post
  // — but a category that is not on the list is a typo worth stopping on.
  const category = asString(file.category) || DEFAULT_BLOG_CATEGORY
  if (!(BLOG_CATEGORIES as readonly string[]).includes(category)) {
    errors.push(`unknown \`category\` "${category}" — expected one of ${BLOG_CATEGORIES.join(', ')}`)
  }

  // Resolved at the last possible moment, which is what makes "random" mean
  // per post, not per queue.
  const rawCta = asString(file.ctaVariant)
  const ctaVariant = rawCta === RANDOM_CTA_VARIANT ? pickRandomCtaVariant() : rawCta
  if (ctaVariant && !CTA_VARIANT_IDS.includes(ctaVariant)) {
    errors.push(`unknown \`ctaVariant\` "${ctaVariant}" — see src/modules/blog-writer/lib/cta-variants.ts`)
  }

  const rawCount = typeof file.imageCount === 'number' ? file.imageCount : 0
  const imageCount = Math.min(MAX_IMAGES, Math.max(MIN_IMAGES, Math.round(rawCount)))

  // Snapped to an offered length rather than trusted, and defaulted rather than rejected.
  const targetWords = clampWords(file.targetWords)

  const researchMode = asString(file.researchMode)
  if (researchMode && !(RESEARCH_MODES as readonly string[]).includes(researchMode)) {
    errors.push(`unknown \`researchMode\` "${researchMode}" — expected news-led, recent or evergreen`)
  }

  const sourceUrl = asString(file.sourceUrl)
  if (sourceUrl && !/^https?:\/\//i.test(sourceUrl)) errors.push('`sourceUrl` must start with http:// or https://')

  const sources: SourceRef[] = Array.isArray(file.sources)
    ? (file.sources as Record<string, unknown>[])
        .map((entry) => ({ url: asString(entry?.['url']), name: asString(entry?.['name']), title: asString(entry?.['title']) }))
        .filter((entry) => entry.url)
    : []

  if (errors.length) return { errors }

  return {
    errors: [],
    post: {
      title,
      slug,
      excerpt,
      content,
      category,
      tags: asStringArray(file.tags),
      seoTitle: asString(file.seoTitle),
      seoDescription: asString(file.seoDescription),
      seoKeywords: asString(file.seoKeywords),
      targetKeyword: asString(file.targetKeyword),
      ctaVariant,
      imageCount,
      targetWords,
      sources,
      sourceUrl,
      sourceName: asString(file.sourceName),
      researchMode,
      topicId: asString(file.topicId),
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Internal links                                                             */
/* -------------------------------------------------------------------------- */

/** Every anchor, with its attribute string and its href. */
const ANCHOR_RE = /<a\b([^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*)>/gi

/** The site-relative path an href addresses, or null when it points somewhere that is not us. */
function internalPath(href: string): string | null {
  if (href.startsWith('/') && !href.startsWith('//')) return href
  if (!href.startsWith('http://') && !href.startsWith('https://')) return null

  try {
    const url = new URL(href)
    return isOwnHost(url.hostname) ? `${url.pathname}${url.search}${url.hash}` : null
  } catch {
    return null
  }
}

/** A path with its query and fragment removed, which is what decides the page. */
function bareRoute(route: string): string {
  const withoutQuery = route.replace(/[#?].*$/, '')
  return withoutQuery.replace(/\/+$/, '') || '/'
}

/** Whether a site-relative route actually resolves to a page. */
async function routeExists(route: string): Promise<boolean> {
  if (STATIC_ROUTE_SET.has(route)) return true

  const parts = route.split('/').filter(Boolean)
  if (parts.length !== 2) return false

  const [section, slug] = parts as [string, string]
  try {
    if (section === 'case-studies') return Boolean(await prisma.caseStudy.findFirst({ where: { slug }, select: { id: true } }))
    if (section === 'blog') return Boolean(await prisma.blogPost.findFirst({ where: { slug }, select: { id: true } }))
  } catch {
    // A lookup that fails is not proof the page is missing.
    return true
  }
  return false
}

/**
 * Check every internal link in a draft, and normalise the ones that are fine:
 * an absolute URL on our own domain becomes the relative path, and
 * target="_blank" and its rel are dropped. Anything still unresolved is
 * returned as broken; nothing is deleted, so an editor can see what was meant.
 */
async function checkInternalLinks(html: string): Promise<{ html: string; broken: string[] }> {
  const verdict = new Map<string, boolean>()

  for (const match of html.matchAll(ANCHOR_RE)) {
    const route = internalPath(match[2] ?? '')
    if (route === null) continue
    const bare = bareRoute(route)
    if (!verdict.has(bare)) verdict.set(bare, await routeExists(bare))
  }

  const broken = [...verdict].filter(([, ok]) => !ok).map(([route]) => route)

  const next = html.replace(ANCHOR_RE, (whole, attrs: string, href: string) => {
    const route = internalPath(href)
    if (route === null) return whole
    if (!verdict.get(bareRoute(route))) return whole

    const cleaned = attrs
      .replace(/\s*\btarget\s*=\s*["'][^"']*["']/gi, '')
      .replace(/\s*\brel\s*=\s*["'][^"']*["']/gi, '')
      .split(`"${href}"`)
      .join(`"${route}"`)
      .split(`'${href}'`)
      .join(`'${route}'`)

    return `<a${cleaned}>`
  })

  return { html: next, broken }
}

/* -------------------------------------------------------------------------- */
/* Images                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Fetch and place a post's pictures. The cover is the first of the count, so
 * `imageCount: 1` means a cover and nothing in the article. Fails soft
 * throughout: a heading with no suitable photo is left without one.
 */
async function attachImages(post: Normalized): Promise<{
  content: string
  coverImage: string
  coverImageAlt: string
  coverCreditHtml: string
  placed: number
}> {
  const empty = { content: post.content, coverImage: '', coverImageAlt: '', coverCreditHtml: '', placed: 0 }
  if (post.imageCount <= 0) return empty

  if (!isPexelsConfigured()) {
    console.log('    (no PEXELS_API_KEY — skipping images)')
    return empty
  }

  const keyword = post.targetKeyword || post.title
  // Shared across the whole post so no two images repeat each other.
  const exclude = new Set<string>()

  const cover = await fetchStockPhoto({ query: keyword, keyword, exclude, role: 'cover' })
  if (cover) exclude.add(cover.sourceUrl)

  const wanted = post.imageCount - (cover ? 1 : 0)
  const slots = findHeadingSlots(post.content)
  const chosen = chooseSlots(slots.length, Math.max(0, wanted))

  const insertions: { at: number; markup: string }[] = []

  for (const index of chosen) {
    const heading = slots[index]
    if (!heading) continue
    const query = queryForHeading(heading.text, keyword)

    let photo = await fetchStockPhoto({ query, keyword, exclude, role: 'body' })
    // A heading-derived query can be too specific for stock to match.
    if (!photo && query !== keyword) photo = await fetchStockPhoto({ query: keyword, keyword, exclude, role: 'body' })
    if (!photo) continue

    exclude.add(photo.sourceUrl)
    insertions.push({ at: heading.insertAt, markup: imageHtml(photo.url, photo.alt, photo.creditHtml) })
  }

  return {
    content: applyInsertions(post.content, insertions),
    coverImage: cover?.url ?? '',
    coverImageAlt: cover?.alt ?? '',
    coverCreditHtml: cover?.creditHtml ?? '',
    placed: (cover ? 1 : 0) + insertions.length,
  }
}

/* -------------------------------------------------------------------------- */
/* Status and the queue                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Decide what status a post is saved with, and say why in words. The watcher
 * reads this script's output to fill the dashboard's progress card, so "held
 * as a draft" always carries its reason.
 */
function decideStatus(draft: DraftFile, wantPublish: boolean, brokenLinks: string[]): { published: boolean; reason: string } {
  // A broken internal link holds the post before auto-publish is even consulted.
  if (brokenLinks.length > 0) {
    return {
      published: false,
      reason: `held as a draft — ${brokenLinks.length} internal link(s) point at pages that do not exist: ${brokenLinks.join(', ')}`,
    }
  }

  if (!wantPublish) return { published: false, reason: '' }

  const errors = audit(draft as Record<string, unknown>).filter((finding) => finding.level === 'error')
  if (errors.length === 0) return { published: true, reason: 'audit clean' }

  return {
    published: false,
    reason: `held as a draft — audit found ${errors.length} error(s): ${errors
      .slice(0, 3)
      .map((finding) => `${finding.check} (${finding.detail})`)
      .join('; ')}`,
  }
}

/**
 * Mark the queued topic this post came from as written. `topicId` is the
 * reliable route; the keyword fallback covers a draft written by hand.
 * Failure is logged and swallowed: the post is already saved.
 */
async function closeTopic(post: Normalized): Promise<void> {
  try {
    if (!post.topicId && !post.targetKeyword) return

    const result = await prisma.blogTopic.updateMany({
      where: post.topicId ? { id: post.topicId } : { topic: post.targetKeyword, status: 'queued' },
      data: { status: 'done', blog_slug: post.slug, written_at: new Date() },
    })

    if (result.count > 0) console.log(`    queue: marked "${post.targetKeyword || post.slug}" done`)
  } catch (error) {
    console.error(`    queue: could not update the topic — ${(error as Error).message}`)
  }
}

async function main(): Promise<void> {
  let files: string[]
  try {
    files = (await readdir(DRAFTS_DIR)).filter((name) => name.endsWith('.json')).sort()
  } catch {
    console.error(`No drafts folder at ${DRAFTS_DIR}. Nothing to import.`)
    return
  }

  if (files.length === 0) {
    console.log('No .json files in content/drafts. Nothing to import.')
    return
  }

  const wantPublish = await autoPublishEnabled()
  if (wantPublish) console.log('auto-publish is on; drafts that pass the audit will go live.\n')

  let created = 0
  let updated = 0
  let skipped = 0
  let failed = 0
  let published = 0
  let held = 0

  for (const name of files) {
    const full = path.join(DRAFTS_DIR, name)

    let parsed: DraftFile
    try {
      parsed = JSON.parse(await readFile(full, 'utf8')) as DraftFile
    } catch (error) {
      console.error(`  ${name}: not valid JSON — ${(error as Error).message}`)
      failed += 1
      continue
    }

    const { post, errors } = normalize(parsed)
    if (!post) {
      console.error(`  ${name}: ${errors.join('; ')}`)
      failed += 1
      continue
    }

    const existing = await prisma.blogPost.findUnique({ where: { slug: post.slug }, select: { id: true, published: true } })

    // A live post is never touched: re-importing is for fixing drafts.
    if (existing?.published) {
      console.log(`  ${name}: skipped — "${post.slug}" is already published`)
      skipped += 1
      continue
    }

    // Internal links, before anything is written — on the body as the writer
    // produced it, so the offsets the images are measured against are not
    // disturbed.
    const links = await checkInternalLinks(post.content)
    post.content = links.html
    if (links.broken.length > 0) {
      console.error(`    links: ${links.broken.length} internal link(s) point at pages that do not exist — ${links.broken.join(', ')}`)
    }

    const { content, coverImage, coverImageAlt, coverCreditHtml, placed } = await attachImages(post)

    // The CTA token is swapped AFTER the images, whose insertion points were
    // measured against the body as written. Sources are stored as JSON (the
    // site renders them as a fold under the article), so no trailer is added
    // to the body; only the cover's credit is appended.
    const positioned = placeCtaSlot(content, CTA_MARKER)
    const body = [positioned, coverCreditHtml].filter(Boolean).join('\n')

    const verdict = decideStatus(parsed, wantPublish, links.broken)
    const words = countWords(stripTags(post.content))

    const data = {
      title: post.title,
      excerpt: post.excerpt,
      content: body,
      category: post.category,
      tags: post.tags,
      cover_image: coverImage || undefined,
      cover_image_alt: coverImageAlt || undefined,
      reading_time: readingTimeFor(words),
      seo_title: post.seoTitle,
      seo_description: post.seoDescription,
      seo_keywords: post.seoKeywords,
      target_keyword: post.targetKeyword,
      cta_variant: post.ctaVariant || null,
      sources: post.sources.map((source) => ({ ...source, cited: true })),
      research_mode: post.researchMode || null,
      source_url: post.sourceUrl || null,
      source_name: post.sourceName || null,
      topic_id: post.topicId || null,
      published: verdict.published,
      // Set alongside the status: a published post with no date sorts to the
      // bottom of every list that orders by it.
      ...(verdict.published ? { published_at: new Date() } : {}),
    }

    if (existing) {
      await prisma.blogPost.update({ where: { slug: post.slug }, data })
      updated += 1
    } else {
      await prisma.blogPost.create({ data: { slug: post.slug, ...data } })
      created += 1
    }

    const extras = [
      placed ? `${placed} image${placed === 1 ? '' : 's'}` : '',
      post.imageCount && placed < post.imageCount ? `wanted ${post.imageCount}` : '',
      post.ctaVariant ? `cta: ${post.ctaVariant}` : '',
      post.sources.length ? `${post.sources.length} sources` : '',
    ].filter(Boolean)
    const suffix = extras.length ? ` (${extras.join(', ')})` : ''
    const word = verdict.published ? 'published' : 'draft'

    // This line is what the watcher's tracker reads the slug from; keep its
    // shape (`created|updated draft|published "slug"`) exactly.
    console.log(`  ${name}: ${existing ? 'updated' : 'created'} ${word} "${post.slug}"${suffix}`)

    if (verdict.published) published += 1
    if (verdict.reason) {
      console.log(`    ${verdict.reason}`)
      if (!verdict.published) held += 1
    }

    await closeTopic(post)

    // Move the file out of the way so the next run doesn't reprocess it. Kept
    // rather than deleted: the JSON is the only copy of the writing outside
    // the database.
    try {
      if (!existsSync(IMPORTED_DIR)) await mkdir(IMPORTED_DIR, { recursive: true })
      await rename(full, path.join(IMPORTED_DIR, name))
    } catch {
      // A tidiness failure, not a real one.
    }
  }

  console.log(`\nDone. ${created} created, ${updated} updated, ${skipped} skipped, ${failed} failed.`)
  if (published) {
    console.log(`${published} went live.`)
    try {
      await sitemapService.refresh()
    } catch (error) {
      // A sitemap refresh failure must never undo an already-published post.
      logger.error('Blog import: posts published but sitemap refresh failed:', error)
    }
  }
  if (held) console.log(`${held} held as draft(s) despite auto-publish — run npm run blog:audit on them to see why.`)
  if (created + updated > published) console.log('Review the drafts in the dashboard under Blog, then publish.')
}

main()
  .catch((error: unknown) => {
    console.error('Blog import failed:', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await disconnectDatabase()
  })
