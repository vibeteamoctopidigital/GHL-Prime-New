import { CTA_VARIANTS } from './cta-variants.js'
import { isOwnHost } from './site.js'
import { BLOG_CATEGORIES, DEFAULT_WORDS, structureBudgetFor, wordRangeFor } from './rules.js'

/**
 * Check a finished draft against the rules the writing standard actually
 * states.
 *
 * A script runs the same list every time and says so with an exit code, which
 * is what lets an unattended run be trusted at all. Where a rule states a hard
 * limit it is an ERROR here; where it states judgement it is a WARNING.
 *
 * Two callers need the same verdict: `npm run blog:audit`, and the importer's
 * auto-publish gate. A post going live at seven in the morning with nobody
 * reading it must clear the same bar as one a person checked.
 */
export const CTA_MARKER = '[[CTA]]'

/** Tags the writer may not produce (the site renders the title, and the body is sanitised). */
const DISALLOWED_TAGS = /<\s*(h1|div|span|script|style|iframe|form|figure|figcaption)\b/gi

/**
 * Phrases the standard bans outright. Deliberately not a cleverness contest:
 * these are the literal strings named in the rules.
 */
const BANNED_PHRASES = [
  "it's not just", "isn't just", 'not merely', 'at its core', 'in essence',
  'the key is', 'when it comes to', 'in conclusion', 'the bottom line',
  "let's dive", "let's break down", "it's worth noting", "you're not alone",
  'ask yourself', 'best of both worlds', 'more than just a', 'half the equation',
  'the smarter route', 'the safer bet', 'pays for itself', 'is reshaping',
  'is rapidly becoming', 'plays a crucial role', "in today's landscape",
  'the message is clear', 'studies show', 'experts agree', 'research suggests',
  'best practice dictates', "it's widely accepted", 'honestly?', "let's be real",
  'truth be told', 'look, the reality',
]

/** Openers that perform candour rather than being candid. */
const FAKE_CANDOUR = /\b(i'?ll be straight with you|to be honest|honestly,|truth be told|let's be real)\b/gi

/**
 * Internal links are the commercial point of the blog. Zero is an ERROR
 * because zero is never a judgement call: it means the writer was handed no
 * pages to link to, which is a generation failure wearing the costume of a
 * finished post.
 */
const MIN_INTERNAL_LINKS = 3

/** How many times a post should link out to the sources it cites. */
const MIN_EXTERNAL_LINKS = 3

/** Count links pointing at our own site — site-relative or absolute on our domain. */
function countInternalLinks(html: string): number {
  let found = 0
  for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["']/gi)) {
    const href = match[1] ?? ''
    // Site-relative. "//evil.com" is protocol-relative and is not ours.
    if (href.startsWith('/') && !href.startsWith('//')) {
      found += 1
      continue
    }
    try {
      if (isOwnHost(new URL(href).hostname)) found += 1
    } catch {
      /* Not a URL anything can resolve, so not an internal link either. */
    }
  }
  return found
}

/**
 * Links pointing away from our site. A machine-built sources list at the
 * bottom is excluded deliberately: a post whose only outbound links sit there
 * is exactly the post this check exists to catch.
 */
function countExternalLinks(html: string): number {
  const trailer = html.search(/<h2[^>]*>\s*Sources\s*<\/h2>/i)
  const body = trailer === -1 ? html : html.slice(0, trailer)

  let found = 0
  for (const match of body.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["']/gi)) {
    const href = match[1] ?? ''
    if (!href.startsWith('http://') && !href.startsWith('https://')) continue
    try {
      if (!isOwnHost(new URL(href).hostname)) found += 1
    } catch {
      /* Not a URL anything can resolve, so not a citation either. */
    }
  }
  return found
}

export type Finding = { level: 'error' | 'warn'; check: string; detail: string }

export function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Paragraph text, one entry per <p>, tags removed. */
function paragraphs(html: string): string[] {
  return [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => stripTags(m[1] ?? '')).filter(Boolean)
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

function hasFigure(sentence: string): boolean {
  return /[$£€]\s?[\d,]|\b\d+(\.\d+)?\s?(%|percent)\b|\b\d{2,}\b/.test(sentence)
}

export function audit(draft: Record<string, unknown>): Finding[] {
  const out: Finding[] = []
  const add = (level: Finding['level'], check: string, detail: string) => out.push({ level, check, detail })

  // The length this post was ASKED for, which decides both how much structure
  // it may carry and whether its word count is right.
  const target = typeof draft['targetWords'] === 'number' && draft['targetWords'] > 0 ? draft['targetWords'] : DEFAULT_WORDS
  const budget = structureBudgetFor(target)

  const content = typeof draft['content'] === 'string' ? draft['content'] : ''
  const title = typeof draft['title'] === 'string' ? draft['title'] : ''
  const keyword = typeof draft['targetKeyword'] === 'string' ? draft['targetKeyword'] : ''
  const body = stripTags(content)
  const words = countWords(body)

  if (!content) {
    add('error', 'content', 'missing')
    return out
  }

  /* ---- Absolute formatting rules ---- */

  const emDashes = (content.match(/—/g) ?? []).length
  if (emDashes > 0) add('error', 'em dashes', `${emDashes} found, must be 0`)

  const curly = (content.match(/[“”‘’]/g) ?? []).length
  if (curly > 0) add('error', 'curly quotes', `${curly} found, straight quotes only`)

  // Ceilings only. A post carrying no list and no table is never flagged for it.
  const lists = (content.match(/<(ul|ol)\b/gi) ?? []).length
  if (lists > budget.lists) add('error', 'lists', `${lists} found, at most ${budget.lists} at ${target} words`)

  const tables = (content.match(/<table\b/gi) ?? []).length
  if (tables > budget.tables) add('warn', 'tables', `${tables} found, at most ${budget.tables} at ${target} words`)

  // Reported, and only reported: a run of posts that are solid walls of prose
  // is a complaint worth hearing, but requiring structure produces tables
  // nobody needed.
  if (lists === 0 && tables === 0) {
    add('warn', 'structure', 'no list and no table; check the material really was prose all the way')
  }

  const internalLinks = countInternalLinks(content)
  if (internalLinks === 0) {
    add('error', 'internal links', `0 found, at least ${MIN_INTERNAL_LINKS} required`)
  } else if (internalLinks < MIN_INTERNAL_LINKS) {
    add('warn', 'internal links', `${internalLinks} found, ${MIN_INTERNAL_LINKS} expected`)
  }

  const externalLinks = countExternalLinks(content)
  const sourceCount = Array.isArray(draft['sources']) ? draft['sources'].length : 0
  if (sourceCount > 0 && externalLinks < Math.min(MIN_EXTERNAL_LINKS, sourceCount)) {
    add(
      'warn',
      'external links',
      `${externalLinks} found against ${sourceCount} source(s); link the sentence that cites each figure`,
    )
  }

  const bad = content.match(DISALLOWED_TAGS)
  if (bad) add('error', 'tags', `disallowed: ${[...new Set(bad)].join(', ')}`)

  const markers = content.split(CTA_MARKER).length - 1
  if (markers !== 1) add('error', 'CTA marker', `${markers} found, must be exactly 1`)

  /* ---- Keyword placement ---- */

  if (!keyword) {
    add('error', 'targetKeyword', 'missing')
  } else {
    const first120 = body.split(/\s+/).slice(0, 120).join(' ').toLowerCase()
    if (!first120.includes(keyword.toLowerCase())) add('error', 'keyword', 'not in the first 120 words')

    const headings = [...content.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)].map((m) => stripTags(m[1] ?? '').toLowerCase())
    if (!headings.some((h) => h.includes(keyword.toLowerCase()))) add('warn', 'keyword', 'not in any <h2>')

    if (!title.toLowerCase().includes(keyword.toLowerCase())) add('warn', 'keyword', 'not in the title')
  }

  /* ---- Headings ---- */

  const h2s = [...content.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)].map((m) => stripTags(m[1] ?? ''))
  const colonHeadings = h2s.filter((h) => h.includes(':')).length
  if (colonHeadings > 1) add('warn', 'headings', `${colonHeadings} use a colon, at most 1 should`)
  const duplicates = h2s.length - new Set(h2s).size
  if (duplicates > 0) add('error', 'headings', `${duplicates} duplicate heading(s)`)

  /* ---- Rhythm ---- */

  const paras = paragraphs(content)
  const longParas = paras.filter((p) => countWords(p) > 50)
  if (longParas.length > 0) {
    add('warn', 'paragraphs', `${longParas.length} over 50 words (first: "${longParas[0]!.slice(0, 48)}…")`)
  }

  // Two sentences in a row opening on the same word is the cheapest proxy for
  // the uniformity rule.
  const repeats: string[] = []
  for (const para of paras) {
    const opens = sentences(para).map((s) => s.split(/\s+/)[0]?.toLowerCase() ?? '')
    for (let i = 1; i < opens.length; i++) {
      if (opens[i] && opens[i] === opens[i - 1]) repeats.push(opens[i]!)
    }
  }
  if (repeats.length > 0) {
    add('warn', 'sentence openings', `${repeats.length} consecutive repeat(s): ${[...new Set(repeats)].join(', ')}`)
  }

  /* ---- Evidence density ---- */

  for (const para of paras) {
    const sents = sentences(para)
    for (let i = 1; i < sents.length; i++) {
      if (hasFigure(sents[i]!) && hasFigure(sents[i - 1]!)) {
        add('warn', 'figures', `adjacent sentences both carry a number: "${sents[i]!.slice(0, 44)}…"`)
        break
      }
    }
  }

  /* ---- Wording ---- */

  const lower = body.toLowerCase()
  const hits = BANNED_PHRASES.filter((phrase) => lower.includes(phrase))
  if (hits.length > 0) add('error', 'banned phrases', hits.join('; '))

  const candour = body.match(FAKE_CANDOUR)
  if (candour) add('error', 'fake candour', [...new Set(candour)].join('; '))

  if (!/\b(don't|it's|you'll|that's|isn't|won't|they're|we're|here's|doesn't)\b/i.test(body)) {
    add('warn', 'contractions', 'none found; a long article without them reads as generated')
  }

  /* ---- Length and metadata ---- */

  const range = wordRangeFor(target)
  if (words < range.min) {
    add('warn', 'length', `${words} words, under the ${range.min}-${range.max} band for a ${target} post`)
  } else if (words > range.max) {
    add('warn', 'length', `${words} words, over the ${range.min}-${range.max} band for a ${target} post`)
  }

  if (title.length > 70) add('error', 'title', `${title.length} chars, hard limit is 70`)
  else if (title.length > 60) add('warn', 'title', `${title.length} chars, ideally under 60`)

  const seoTitle = typeof draft['seoTitle'] === 'string' ? draft['seoTitle'] : ''
  if (seoTitle.length > 60) add('warn', 'seoTitle', `${seoTitle.length} chars, ideally under 60`)

  const seoDescription = typeof draft['seoDescription'] === 'string' ? draft['seoDescription'] : ''
  if (seoDescription.length > 160) add('warn', 'seoDescription', `${seoDescription.length} chars, ideally under 160`)

  const excerpt = typeof draft['excerpt'] === 'string' ? draft['excerpt'] : ''
  if (!excerpt) add('error', 'excerpt', 'missing')
  else if (excerpt.length > 300) add('warn', 'excerpt', `${excerpt.length} chars, aim for ~300`)

  /* ---- Fields the importer will reject anyway, caught earlier ---- */

  const category = typeof draft['category'] === 'string' ? draft['category'] : ''
  if (!category) add('error', 'category', `missing; pick one of ${BLOG_CATEGORIES.join(', ')}`)
  else if (!(BLOG_CATEGORIES as readonly string[]).includes(category)) {
    add('error', 'category', `"${category}" is not one of ${BLOG_CATEGORIES.join(', ')}`)
  }

  const mode = typeof draft['researchMode'] === 'string' ? draft['researchMode'] : ''
  if (mode && !['news-led', 'recent', 'evergreen'].includes(mode)) {
    add('error', 'researchMode', `"${mode}" is not news-led, recent or evergreen`)
  }

  const cta = typeof draft['ctaVariant'] === 'string' ? draft['ctaVariant'] : ''
  if (cta && !CTA_VARIANTS.some((v) => v.id === cta)) add('error', 'ctaVariant', `"${cta}" is not a known CTA banner`)

  const sources = Array.isArray(draft['sources']) ? draft['sources'] : []
  if (sources.length === 0) {
    add('error', 'sources', 'empty; a post citing figures must say where they came from')
  } else if (sources.length < 3) {
    add('warn', 'sources', `${sources.length} source(s); the rules ask for 3-6`)
  }

  const publishers = new Set(
    sources
      .map((s) => (typeof (s as { name?: unknown })?.name === 'string' ? (s as { name: string }).name : ''))
      .filter(Boolean),
  )
  if (sources.length >= 3 && publishers.size < 2) {
    add('warn', 'sources', 'all from one publisher; no source may carry more than about a third')
  }

  return out
}
