/**
 * Print the blog queue, for the writing workflow to read.
 *
 * The queue lives in Postgres so the dashboard can edit it, and this is how
 * the writer gets at it. A command rather than a direct query because the
 * writer runs under a scoped tool allowlist: one named script it may run is a
 * much smaller grant than the shell access an ad-hoc query would need.
 *
 *   npm run blog:queue            plain text
 *   npm run blog:queue -- --json  machine-readable
 */
import prisma, { disconnectDatabase } from '../src/config/prisma.js'
import { getQueueDefaults } from '../src/modules/blog-writer/blogWriter.store.js'
import { RANDOM_CTA_VARIANT, resolveCtaVariant } from '../src/modules/blog-writer/lib/cta-variants.js'
import { BLOG_CATEGORIES, resolveTopicSettings } from '../src/modules/blog-writer/lib/rules.js'
import { SERVICE_PAGES } from '../src/modules/blog-writer/lib/site.js'

/** Titles may carry HTML; a link label is plain text. */
function plain(value: string): string {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * How many of each kind to print. Services are never truncated: they are
 * what the posts exist to sell. The other two grow without limit and every
 * line here is context the writer carries for the whole run.
 */
const MAX_CASE_STUDIES = 8
const MAX_POSTS = 12

/**
 * Our own pages a post is allowed to link to.
 *
 * The workflow requires three to six internal links and forbids inventing a
 * URL, so this list is the whole of what it may choose from. Without it the
 * writer is asked for links, given nothing to pick, and correctly writes none.
 */
async function loadInternalLinks(): Promise<{ label: string; url: string }[]> {
  const [caseStudies, posts] = await Promise.all([
    prisma.caseStudy.findMany({
      where: { published: true },
      select: { slug: true, title: true },
      orderBy: { created_at: 'desc' },
      take: MAX_CASE_STUDIES,
    }),
    prisma.blogPost.findMany({
      where: { published: true },
      select: { slug: true, title: true },
      orderBy: { published_at: 'desc' },
      take: MAX_POSTS,
    }),
  ])

  const links: { label: string; url: string }[] = SERVICE_PAGES.map((page) => ({ label: page.label, url: page.url }))

  for (const study of caseStudies) {
    if (!study.slug) continue
    links.push({ label: plain(study.title || study.slug), url: `/case-studies/${study.slug}` })
  }
  for (const post of posts) {
    if (!post.slug) continue
    links.push({ label: plain(post.title || post.slug), url: `/blog/${post.slug}` })
  }

  return links.filter((link) => link.label)
}

async function main(): Promise<void> {
  const asJson = process.argv.includes('--json')

  const [rows, defaults, internalLinks] = await Promise.all([
    prisma.blogTopic.findMany({ where: { status: 'queued' }, orderBy: [{ order: 'asc' }, { created_at: 'asc' }] }),
    getQueueDefaults(),
    loadInternalLinks(),
  ])

  // Resolved here rather than left to the caller, so the writer is handed the
  // settings a topic actually runs with and never has to merge them itself.
  const topics = rows.map((row) => {
    const settings = resolveTopicSettings(
      { imageCount: row.image_count, words: row.words, ctaVariant: row.cta_variant },
      defaults,
    )
    return {
      id: row.id,
      topic: row.topic,
      kind: row.kind,
      notes: row.notes,
      ...settings,
      // Resolved per topic, so "random" genuinely differs post to post.
      ctaVariant: resolveCtaVariant(settings.ctaVariant),
    }
  })

  if (asJson) {
    console.log(JSON.stringify({ defaults, categories: BLOG_CATEGORIES, topics, internalLinks }, null, 2))
    return
  }

  console.log(`posts per run: ${defaults.postsPerRun}`)
  console.log(`default images: ${defaults.imageCount}`)
  console.log(`default words: ${defaults.words}`)
  console.log(
    `default cta: ${defaults.ctaVariant}${defaults.ctaVariant === RANDOM_CTA_VARIANT ? ' (a different banner per post)' : ''}`,
  )
  console.log(`auto-publish: ${defaults.autoPublish ? 'on (clean drafts go live)' : 'off'}`)
  console.log(`categories (pick exactly one per post): ${BLOG_CATEGORIES.join(', ')}`)
  console.log(`\n${topics.length} queued\n`)
  topics.forEach((topic, i) => {
    console.log(`${i + 1}. [${topic.kind}] ${topic.topic}`)
    console.log(`   images: ${topic.imageCount} | words: ${topic.words} | cta: ${topic.ctaVariant} | id: ${topic.id}`)
    if (topic.notes) console.log(`   notes: ${topic.notes}`)
  })
  if (topics.length === 0) console.log('(nothing queued)')

  console.log('\ninternal links — our own pages, the ONLY ones a post may link to.')
  console.log('Copy a path exactly as written. Never guess one that is not here.\n')
  for (const link of internalLinks) console.log(`   ${link.url}  —  ${link.label}`)
  if (internalLinks.length === 0) {
    console.log('   (none found — services, case studies and posts all came back empty)')
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(async () => {
    await disconnectDatabase()
  })
