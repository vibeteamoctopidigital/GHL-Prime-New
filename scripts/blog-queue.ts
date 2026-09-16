/**
 * The DB plumbing a spawned writer session calls throughout one run — it has
 * no other way to touch Postgres (it isn't handed a connection string or API
 * token, only these scripts). blog-watch.mjs does exactly one thing to this
 * data itself (the claim transaction that flips a row to 'running'); every
 * update after that point comes from the session calling this script.
 *
 * Usage (invoked via `npx tsx scripts/blog-queue.ts <command> ...args`):
 *
 *   get <request_id>
 *     Prints { request, topic } as JSON — what to write about.
 *
 *   phase <request_id> <phase> [note]
 *     phase is one of: reading_standard | researching | writing | auditing |
 *     images | saving. Appends { phase, at, note } to the request's `steps`
 *     timeline — this is what the admin UI's phase list actually reads.
 *
 *   save <request_id> <draft.json> <audit_passed:true|false>
 *     Creates the BlogPost row and marks the request + topic completed.
 *     draft.json shape: { title, slug?, category, tags?, excerpt?,
 *     cover_image?, reading_time?, content, seo_title?, seo_description?,
 *     seo_keywords?, target_keyword?, cta_variant?, sources?, source_url?,
 *     source_name? }. Publishing (vs. saving a draft) is decided HERE, from
 *     BlogWriterSettings.auto_publish_enabled AND audit_passed — never by
 *     the session's own judgment call.
 *
 *   fail <request_id> <reason>
 *     Marks the request failed and its topic skipped with the same reason.
 */
import { readFileSync } from 'node:fs'
import prisma, { disconnectDatabase } from '../src/config/prisma.js'
import sitemapService from '../src/modules/sitemap/sitemap.service.js'
import logger from '../src/shared/utils/logger.js'

type Phase = 'reading_standard' | 'researching' | 'writing' | 'auditing' | 'images' | 'saving'

interface DraftInput {
  title: string
  slug?: string
  category: string
  tags?: string[]
  author?: string
  excerpt?: string
  cover_image?: string
  reading_time?: number
  content: string
  seo_title?: string
  seo_description?: string
  seo_keywords?: string
  target_keyword?: string
  cta_variant?: string
  sources?: Array<{ url: string; name?: string }>
  research_mode?: string
  source_url?: string
  source_name?: string
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}

/** Appends -2, -3, ... until the slug is free — a topic like "GHL Setup Guide" recurring over time must never collide silently. */
async function uniqueSlug(base: string): Promise<string> {
  let candidate = base
  let n = 2
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const existing = await prisma.blogPost.findUnique({ where: { slug: candidate }, select: { id: true } })
    if (!existing) return candidate
    candidate = `${base}-${n}`
    n += 1
  }
}

async function cmdGet(requestId: string): Promise<void> {
  const request = await prisma.blogWriteRequest.findUnique({
    where: { id: requestId },
    include: { topic: true, schedule: true },
  })
  if (!request) throw new Error(`Request ${requestId} not found`)

  console.log(JSON.stringify({ request, topic: request.topic }, null, 2))
}

async function cmdPhase(requestId: string, phase: string, note?: string): Promise<void> {
  const valid: Phase[] = ['reading_standard', 'researching', 'writing', 'auditing', 'images', 'saving']
  if (!valid.includes(phase as Phase)) {
    throw new Error(`Unknown phase "${phase}" — expected one of ${valid.join(', ')}`)
  }

  const request = await prisma.blogWriteRequest.findUnique({ where: { id: requestId } })
  if (!request) throw new Error(`Request ${requestId} not found`)

  const steps = Array.isArray(request.steps) ? (request.steps as unknown[]) : []
  steps.push({ phase, at: new Date().toISOString(), note: note ?? null })

  await prisma.blogWriteRequest.update({
    where: { id: requestId },
    data: { phase, steps: steps as never },
  })

  console.log(`OK phase=${phase}`)
}

async function cmdSave(requestId: string, draftPath: string, auditPassedRaw: string): Promise<void> {
  const auditPassed = auditPassedRaw === 'true'
  const draft = JSON.parse(readFileSync(draftPath, 'utf8')) as DraftInput

  const request = await prisma.blogWriteRequest.findUnique({ where: { id: requestId } })
  if (!request) throw new Error(`Request ${requestId} not found`)
  if (request.status !== 'running') {
    throw new Error(`Request ${requestId} is "${request.status}", not "running" — refusing to save (was it already claimed by another run?)`)
  }

  const settings = await prisma.blogWriterSettings.upsert({
    where: { id: true },
    update: {},
    create: { id: true },
  })

  const shouldPublish = settings.auto_publish_enabled && auditPassed
  const slug = await uniqueSlug(slugify(draft.slug ?? draft.title))

  const post = await prisma.$transaction(async (tx) => {
    const created = await tx.blogPost.create({
      data: {
        slug,
        title: draft.title,
        category: draft.category,
        tags: draft.tags ?? [],
        author: draft.author,
        excerpt: draft.excerpt,
        cover_image: draft.cover_image,
        reading_time: draft.reading_time,
        content: draft.content,
        seo_title: draft.seo_title,
        seo_description: draft.seo_description,
        seo_keywords: draft.seo_keywords,
        published: shouldPublish,
        published_at: shouldPublish ? new Date() : null,
        target_keyword: draft.target_keyword,
        cta_variant: draft.cta_variant,
        sources: draft.sources as never,
        research_mode: draft.research_mode,
        source_url: draft.source_url,
        source_name: draft.source_name,
        topic_id: request.topic_id,
      },
    })

    await tx.blogWriteRequest.update({
      where: { id: requestId },
      data: { status: 'completed', phase: 'saving', blog_post_id: created.id, finished_at: new Date() },
    })

    if (request.topic_id) {
      await tx.blogTopic.update({ where: { id: request.topic_id }, data: { status: 'completed' } })
    }

    return created
  })

  if (shouldPublish) {
    try {
      await sitemapService.refresh()
    } catch (error) {
      // A sitemap refresh failure must never undo an already-saved, already-
      // published post — log it and move on, same as any other best-effort
      // side effect elsewhere in this app (see server.ts's boot-time
      // scheduler init for the same pattern).
      logger.error('Blog Writer: post published but sitemap refresh failed:', error)
    }
  }

  console.log(JSON.stringify({ ok: true, post_id: post.id, slug: post.slug, published: shouldPublish }))
}

async function cmdFail(requestId: string, reason: string): Promise<void> {
  const request = await prisma.blogWriteRequest.findUnique({ where: { id: requestId } })
  if (!request) throw new Error(`Request ${requestId} not found`)

  await prisma.$transaction(async (tx) => {
    await tx.blogWriteRequest.update({
      where: { id: requestId },
      data: { status: 'failed', error: reason, finished_at: new Date() },
    })

    if (request.topic_id) {
      await tx.blogTopic.update({
        where: { id: request.topic_id },
        data: { status: 'skipped', skip_reason: reason },
      })
    }
  })

  console.log('OK failed')
}

const [, , command, ...args] = process.argv

try {
  switch (command) {
    case 'get':
      await cmdGet(args[0]!)
      break
    case 'phase':
      await cmdPhase(args[0]!, args[1]!, args[2])
      break
    case 'save':
      await cmdSave(args[0]!, args[1]!, args[2]!)
      break
    case 'fail':
      await cmdFail(args[0]!, args.slice(1).join(' '))
      break
    default:
      console.error('Usage: blog-queue.ts <get|phase|save|fail> ...args')
      process.exitCode = 1
  }
} catch (error) {
  console.error('blog-queue failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  await disconnectDatabase()
}
