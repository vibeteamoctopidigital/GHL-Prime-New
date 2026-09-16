/**
 * Audits a draft before it's saved. The spawned writer session runs this
 * itself and passes the result to `blog-queue.ts save` — auto-publish only
 * ever happens when this comes back passed=true AND the admin has
 * auto_publish_enabled on (that second check happens in blog-queue.ts, not
 * here — this script only ever judges the draft, never the setting).
 *
 *   npx tsx scripts/blog-audit.ts <draft.json>
 *
 * Prints { passed, score, issues: string[] } as JSON. `passed` requires both
 * score >= min_seo_score AND zero hard-fail issues (a banned phrase or a
 * competitor-domain link fails regardless of score).
 */
import { readFileSync } from 'node:fs'
import prisma, { disconnectDatabase } from '../src/config/prisma.js'

interface DraftInput {
  title: string
  category?: string
  content: string
  seo_title?: string
  seo_description?: string
  target_keyword?: string
}

const BANNED_PHRASES = [
  '—', // em dash
  'in today\'s fast-paced world',
  'in conclusion',
  'in the ever-evolving',
  'unlock the power of',
]

/** Counts <a href="..."> and markdown [text](url) links pointing at ghlprime.com or a relative path — the ones max_internal_links caps. */
function countInternalLinks(content: string): number {
  const htmlLinks = content.match(/<a\s+[^>]*href=["']([^"']+)["']/gi) ?? []
  const mdLinks = content.match(/\]\((\/[^)]*|https?:\/\/[^)]*ghlprime\.com[^)]*)\)/gi) ?? []

  const htmlInternal = htmlLinks.filter((tag) => /href=["'](\/|https?:\/\/[^"']*ghlprime\.com)/i.test(tag))
  return htmlInternal.length + mdLinks.length
}

function findCompetitorLinks(content: string, competitorDomains: string[]): string[] {
  if (!competitorDomains.length) return []
  return competitorDomains.filter((domain) => content.toLowerCase().includes(domain.toLowerCase()))
}

async function main(): Promise<void> {
  const draftPath = process.argv[2]
  if (!draftPath) throw new Error('Usage: blog-audit.ts <draft.json>')

  const draft = JSON.parse(readFileSync(draftPath, 'utf8')) as DraftInput
  const settings = await prisma.blogWriterSettings.upsert({
    where: { id: true },
    update: {},
    create: { id: true },
  })

  const issues: string[] = []
  let hardFail = false
  let score = 100

  if (!draft.title || draft.title.trim().length < 10) {
    issues.push('Title is missing or too short')
    score -= 20
  }

  const wordCount = draft.content.replace(/<[^>]*>/g, ' ').trim().split(/\s+/).filter(Boolean).length
  if (wordCount < 400) {
    issues.push(`Content is only ${wordCount} words — too thin to be useful`)
    score -= 25
  }

  for (const phrase of BANNED_PHRASES) {
    if (draft.content.toLowerCase().includes(phrase.toLowerCase())) {
      issues.push(`Contains a banned phrase/character: "${phrase}"`)
      hardFail = true
    }
  }

  if (draft.target_keyword) {
    const kw = draft.target_keyword.toLowerCase()
    if (!draft.title.toLowerCase().includes(kw)) {
      issues.push('Target keyword does not appear in the title')
      score -= 10
    }
    if (!draft.content.toLowerCase().includes(kw)) {
      issues.push('Target keyword does not appear in the body')
      score -= 10
    }
  }

  if (draft.seo_title && draft.seo_title.length > 60) {
    issues.push(`seo_title is ${draft.seo_title.length} characters, over the 60 limit`)
    score -= 5
  }
  if (draft.seo_description && draft.seo_description.length > 155) {
    issues.push(`seo_description is ${draft.seo_description.length} characters, over the 155 limit`)
    score -= 5
  }

  const internalLinks = countInternalLinks(draft.content)
  if (internalLinks > settings.max_internal_links) {
    issues.push(`${internalLinks} internal links found, over the configured max of ${settings.max_internal_links}`)
    score -= 10
  }

  const competitorHits = findCompetitorLinks(draft.content, settings.competitor_domains)
  if (competitorHits.length) {
    issues.push(`Links to configured competitor domain(s): ${competitorHits.join(', ')}`)
    hardFail = true
  }

  score = Math.max(0, Math.min(100, score))
  const passed = !hardFail && score >= settings.min_seo_score

  console.log(JSON.stringify({ passed, score, issues }, null, 2))
}

main()
  .catch((error) => {
    console.error('blog-audit failed:', error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(async () => {
    await disconnectDatabase()
  })
