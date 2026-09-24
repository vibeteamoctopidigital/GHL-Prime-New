/**
 * Where images go inside a finished article, and what to search for.
 *
 * String arithmetic over headings. Pure on purpose: nothing here may reach
 * the network, the database, or an API key — the importer does the fetching
 * and calls in here to decide where the results land.
 */

/** Markup for one placed image. Only tags the site's sanitiser permits: no <figure>, no <figcaption>. */
export function imageHtml(url: string, alt: string, creditHtml: string): string {
  return `<p><img src="${url}" alt="${alt}" loading="lazy" /></p>${creditHtml}`
}

/**
 * Words that make a heading useless as a stock-photo search. "Why It Matters"
 * describes the argument, not anything photographable.
 */
const ABSTRACT_WORDS = new Set([
  'why', 'what', 'how', 'when', 'where', 'who', 'which', 'this', 'that', 'it',
  'its', 'matters', 'means', 'you', 'your', 'our', 'we', 'the', 'a', 'an',
  'and', 'or', 'but', 'for', 'to', 'of', 'in', 'on', 'at', 'is', 'are', 'does',
  'do', 'should', 'can', 'will', 'about', 'with', 'from', 'more', 'most',
  'really', 'actually', 'matter', 'things', 'thing', 'way', 'ways',
])

/**
 * Turn a section heading into something worth searching for. Falls back to
 * the keyword whenever the heading is all argument and no subject.
 */
export function queryForHeading(heading: string, keyword: string): string {
  const words = heading
    .replace(/<[^>]*>/g, ' ')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((word) => !ABSTRACT_WORDS.has(word.toLowerCase()))

  const subject = words.slice(0, 4).join(' ').trim()
  return subject.length >= 4 ? subject : keyword
}

/**
 * Pick which headings get an image. Spread across the article rather than
 * taken in order, so three images in a ten-section post land near the start,
 * middle and end.
 */
export function chooseSlots(available: number, wanted: number): number[] {
  if (available <= 0 || wanted <= 0) return []
  if (wanted >= available) return Array.from({ length: available }, (_, i) => i)

  const slots = new Set<number>()
  for (let i = 0; i < wanted; i++) {
    slots.add(Math.min(available - 1, Math.round(((i + 1) * available) / (wanted + 1))))
  }
  // Rounding can collide on short articles; fill forward from the start.
  for (let i = 0; slots.size < wanted && i < available; i++) slots.add(i)

  return [...slots].sort((a, b) => a - b)
}

export type HeadingSlot = {
  /** The heading's inner HTML, for deriving a search query. */
  text: string
  /** Offset just past the heading's closing tag, where an image belongs. */
  insertAt: number
}

/** Every `<h2>` in the body, with the offset an image would be inserted at. */
export function findHeadingSlots(html: string): HeadingSlot[] {
  return [...html.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)].map((match) => ({
    text: match[1] ?? '',
    insertAt: (match.index ?? 0) + match[0].length,
  }))
}

/**
 * Splice markup into the body at the given offsets. Applied back-to-front so
 * an earlier insertion cannot shift the offsets later ones were measured against.
 */
export function applyInsertions(html: string, insertions: { at: number; markup: string }[]): string {
  let out = html
  for (const insertion of [...insertions].sort((a, b) => b.at - a.at)) {
    out = `${out.slice(0, insertion.at)}${insertion.markup}${out.slice(insertion.at)}`
  }
  return out
}

export type SourceRef = { url: string; name?: string; title?: string }

/**
 * The `[[CTA]]` token is only ever an instruction to the writer. What the
 * reader's page splits on is a paragraph carrying this class (see
 * BlogPostPage.jsx in the site), and nothing downstream understands the raw
 * token — so the importer swaps it for this before saving.
 */
export const CTA_PLACEHOLDER_CLASS = 'ghl-cta-placeholder'
export const CTA_SLOT_HTML = `<p class="${CTA_PLACEHOLDER_CLASS}"></p>`

/**
 * Swap the `[[CTA]]` token for the slot markup. The first token wins; any
 * duplicate is dropped, along with the empty paragraph left behind if the
 * token was written inside one. A post with no token is left alone — the site
 * places the banner by itself when it finds no slot.
 */
export function placeCtaSlot(html: string, marker: string): string {
  if (!html.includes(marker)) return html

  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return html
    .replace(new RegExp(escaped), CTA_SLOT_HTML)
    .replace(new RegExp(escaped, 'g'), '')
    .replace(/<p>\s*<\/p>/g, '')
}
