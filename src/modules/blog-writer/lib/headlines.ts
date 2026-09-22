/**
 * Reading a news site's current headlines, with nothing but HTTP.
 *
 * Feed discovery, feed parsing, and reading a listing page's links by URL
 * shape. No model anywhere: this runs in the watcher on a schedule's behalf,
 * where every site is scanned every day, and a model call per site per day is
 * exactly the cost the scan exists to avoid. Ported from octopi's
 * lib/headlines.ts.
 */

export type FeedArticle = {
  url: string
  title: string
  /**
   * The feed's own summary of the story, tags stripped.
   *
   * Worth having because a headline on its own is often unjudgeable — papers
   * write them to be intriguing rather than informative, and "the quiet
   * revolution nobody saw coming" says nothing about what the story is
   * actually about. Empty for scraped sources, which have no summary to give.
   */
  summary: string
  /** From the feed. Null when scraped, since a section page rarely states one. */
  publishedAt: Date | null
}

/** Long enough to say what a story is about, short enough that 80 of them stay cheap. */
export const MAX_SUMMARY_CHARS = 300

const FETCH_TIMEOUT_MS = 15_000
/** Enough to cover a section page or a full feed; beyond this we're reading assets, not markup. */
const MAX_BYTES = 2_000_000

/**
 * Sent on every request.
 *
 * A plain fetch with no user agent is refused outright by most large news
 * sites, which is indistinguishable from "this source has no articles" unless
 * we look like a browser.
 */
const HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml,application/rss+xml;q=0.9,*/*;q=0.8",
}

export async function fetchText(url: string): Promise<string | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { headers: HEADERS, signal: controller.signal, redirect: "follow" })
    if (!res.ok) return null
    const body = await res.text()
    return body.length > MAX_BYTES ? body.slice(0, MAX_BYTES) : body
  } catch {
    // Unreachable, timed out, or blocked. The caller reports the source as
    // unreadable rather than treating it as empty.
    return null
  } finally {
    clearTimeout(timeout)
  }
}

function absolute(href: string, base: string): string | null {
  try {
    const url = new URL(href, base)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    // The fragment is the same page; keeping it would make one article look
    // like several.
    url.hash = ""
    return url.toString()
  } catch {
    return null
  }
}

export function decodeEntities(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    // Numeric entities generally — feeds encode curly quotes and dashes this
    // way (&#8217; &#8211;), and a headline shown to the ranker or kept as a
    // note should read as the words, not the codes.
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    // Ampersand last, so a double-encoded entity doesn't decode into a tag.
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
}

function tagText(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"))
  return match ? decodeEntities(match[1] ?? "") : ""
}

function parseDate(value: string): Date | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : new Date(ms)
}

/**
 * Feed URLs to try for a section page.
 *
 * The declared one is preferred — a site that advertises its feed is telling
 * us where it is. The guesses cover the common conventions, which most large
 * news sites follow, and cost one HEAD-ish request each only when there is no
 * declaration.
 */
export function candidateFeeds(html: string, pageUrl: string): string[] {
  const declared = [...html.matchAll(/<link\b[^>]*>/gi)]
    .filter((m) => /rel=["']?alternate/i.test(m[0]) && /(rss|atom)\+xml/i.test(m[0]))
    .map((m) => m[0].match(/href=["']([^"']+)["']/i)?.[1])
    .filter((href): href is string => Boolean(href))
    .map((href) => absolute(href, pageUrl))
    .filter((url): url is string => Boolean(url))

  const base = pageUrl.replace(/[?#].*$/, "").replace(/\/+$/, "")
  const guesses = [
    `${base}/rss`,
    `${base}/feed`,
    `${base}.rss`,
    `${base}/rss.xml`,
    `${base}/feed.xml`,
    // The FT and several other publishers expose a section's feed as a query
    // on the section itself rather than as a path beneath it.
    `${base}?format=rss`,
  ]

  // Site-wide feeds, as a last resort. Less targeted than a section feed, but
  // a general technology feed still says what has momentum, and several
  // publishers only offer feeds at the root.
  let roots: string[] = []
  try {
    const { origin } = new URL(pageUrl)
    roots = [`${origin}/rss`, `${origin}/feed`, `${origin}/rss.xml`, `${origin}/latest/rss.xml`]
  } catch {
    // A malformed URL simply gets no root guesses.
  }

  return [...new Set([...declared, ...guesses, ...roots])]
}

export function looksLikeFeed(body: string): boolean {
  return /<rss\b|<feed\b|<rdf:RDF\b/i.test(body.slice(0, 2000))
}

/** Read articles out of an RSS, Atom or RDF feed. */
export function parseFeed(xml: string, base: string): FeedArticle[] {
  const out: FeedArticle[] = []

  // <item> covers RSS and RDF, <entry> covers Atom.
  const blocks = [
    ...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi),
    ...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi),
  ].map((m) => m[0])

  for (const block of blocks) {
    // Atom puts the URL in an attribute; RSS puts it in the element body.
    const atomHref = block.match(/<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i)?.[1]
      || block.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*\/?>/i)?.[1]
    const raw = tagText(block, "link") || atomHref || ""
    const url = raw ? absolute(raw, base) : null
    if (!url) continue

    // Feeds disagree about where the summary lives, and some carry several —
    // the shortest useful one is preferred, since content:encoded is often the
    // entire article and we only want enough to judge the subject by.
    const summary = [
      tagText(block, "description"),
      tagText(block, "summary"),
      tagText(block, "content:encoded"),
      tagText(block, "content"),
    ]
      .map((text) => text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim())
      .filter((text) => text.length > 20)
      .sort((a, b) => a.length - b.length)[0]

    out.push({
      url,
      title: tagText(block, "title"),
      summary: (summary || "").slice(0, MAX_SUMMARY_CHARS),
      publishedAt:
        parseDate(tagText(block, "pubDate")) ??
        parseDate(tagText(block, "published")) ??
        parseDate(tagText(block, "updated")) ??
        parseDate(tagText(block, "dc:date")),
    })
  }

  return out
}

/** Path segments that are section listings, tag pages or utility pages rather than stories. */
const NON_ARTICLE = /\/(tag|tags|topic|topics|category|categories|author|authors|about|contact|subscribe|newsletter|privacy|terms|search|video|videos|podcast|podcasts|live)(\/|$)/i

/**
 * The registrable-ish domain, for deciding whether a link is "this site".
 *
 * Exact hostname matching was too strict: publishers routinely serve a section
 * from www.example.com and its stories from example.com or news.example.com,
 * and every one of those links was being discarded. The last two labels are a
 * deliberate approximation — it treats bbc.co.uk and news.bbc.co.uk as the same
 * site, which is right, and co.uk as a site, which never matters here because
 * both sides of the comparison get the same treatment.
 */
function siteOf(hostname: string): string {
  return hostname.toLowerCase().split(".").slice(-2).join(".")
}

/** Every on-site link with usable anchor text, in page order. The raw material for both link-based passes. */
export function pageLinks(html: string, pageUrl: string): { url: string; text: string }[] {
  const base = new URL(pageUrl)
  const seen = new Set<string>()
  const out: { url: string; text: string }[] = []

  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = absolute(match[1] ?? "", pageUrl)
    if (!url || seen.has(url) || url.replace(/\/$/, "") === pageUrl.replace(/\/$/, "")) continue

    const parsed = new URL(url)
    if (siteOf(parsed.hostname) !== siteOf(base.hostname)) continue
    if (!parsed.pathname || parsed.pathname === "/") continue

    const text = decodeEntities((match[2] ?? "").replace(/<[^>]*>/g, " "))
    if (!text) continue

    seen.add(url)
    out.push({ url, text })
  }

  return out
}

/**
 * Whether a path is shaped like one story rather than a section.
 *
 * An article URL is usually a few segments deep and ends in a slug with real
 * words in it, where navigation and tag pages are shallow. The thresholds are
 * looser than they look: two segments is enough, because plenty of blogs live
 * at /blog/some-post, and a long unhyphenated slug counts too. A short single
 * word at the end — /technology, /uk/technology, /category/ai — is a section.
 */
export function looksLikeArticlePath(pathname: string): boolean {
  const segments = pathname.replace(/\/$/, "").split("/").filter(Boolean)
  if (segments.length < 2) return false

  const slug = segments[segments.length - 1] ?? ""
  return slug.includes("-") ? slug.length >= 8 : slug.length >= 14
}

/**
 * Whether a pasted site URL points at one article instead of a listing.
 *
 * Used when a site is added to a schedule. Any path used to be refused as "one
 * article", which also refused every section page — and a section page is
 * exactly what a schedule wants, since a paper's homepage feed is mostly news
 * the picker throws away while /technology is all stories it can use.
 *
 * Stricter than looksLikeArticlePath, and leaning the other way. The scraper
 * is generous about calling a link an article because a miss there costs one
 * model call; here a wrong "article" refuses a source outright, and section
 * names are often hyphenated (/category/artificial-intelligence) in a way the
 * scraper's rule would flag. So a URL is an article only if it says so
 * plainly: a section word is never one, a dated path always is, and otherwise
 * the slug has to be a headline's worth of words, not a topic's.
 */
export function looksLikeArticleUrl(url: string): boolean {
  let pathname: string
  try {
    pathname = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).pathname
  } catch {
    return false
  }
  if (NON_ARTICLE.test(pathname)) return false

  const segments = pathname.replace(/\/$/, "").split("/").filter(Boolean)
  if (segments.length < 2) return false
  // /2026/09/15/... and /2026/sep/16/... — a date is only ever on a story.
  if (segments.some((segment) => /^(19|20)\d\d$/.test(segment))) return true

  const slug = segments[segments.length - 1] ?? ""
  return slug.includes("-") ? slug.split("-").length >= 5 : slug.length >= 14
}

/**
 * Pull article links out of the listing page by the shape of their URLs.
 *
 * Anything looksLikeArticlePath misses is caught by the AI pass, so being
 * slightly generous there costs a model call at worst — where being strict
 * cost the source entirely.
 */
export function scrapeArticleLinks(html: string, pageUrl: string): FeedArticle[] {
  const out: FeedArticle[] = []

  for (const link of pageLinks(html, pageUrl)) {
    const parsed = new URL(link.url)
    if (NON_ARTICLE.test(parsed.pathname)) continue
    if (!looksLikeArticlePath(parsed.pathname)) continue
    if (link.text.length < 15) continue

    // No summary and no date: a listing page gives the link text and nothing
    // more that can be trusted.
    out.push({ url: link.url, title: link.text, summary: "", publishedAt: null })
  }

  return out
}


/** A page's own headline, for treating the link itself as the article. */
export function pageTitle(html: string): string {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1]
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]
  return decodeEntities((og || h1 || title || "").replace(/<[^>]*>/g, " "))
}

/** Roughly how much readable text the page has, ignoring markup, script and style. */
export function readableLength(html: string): number {
  return html
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim().length
}

/**
 * The headlines a site is showing right now, found without a model.
 *
 * Feed first, then the page's own links judged by URL shape. No AI fallback:
 * this runs in the watcher on the schedule's behalf, where every site is
 * scanned every day, and a model call per site per day is exactly the cost
 * the scan exists to avoid. A site that neither has a feed nor links like a
 * news site comes back empty, and the schedule screen says so.
 */
export async function discoverHeadlines(
  siteUrl: string,
): Promise<{ articles: FeedArticle[]; via: "feed" | "scrape" | "none"; error?: string }> {
  const url = /^https?:\/\//i.test(siteUrl) ? siteUrl : `https://${siteUrl}`

  const page = await fetchText(url)

  if (page && looksLikeFeed(page)) {
    const articles = parseFeed(page, url)
    if (articles.length > 0) return { articles, via: "feed" }
  }

  for (const candidate of candidateFeeds(page || "", url)) {
    const body = await fetchText(candidate)
    if (!body || !looksLikeFeed(body)) continue
    const articles = parseFeed(body, candidate)
    if (articles.length > 0) return { articles, via: "feed" }
  }

  if (!page) return { articles: [], via: "none", error: "blocked us, and no feed found" }

  const scraped = scrapeArticleLinks(page, url)
  if (scraped.length > 0) return { articles: scraped, via: "scrape" }

  return { articles: [], via: "none", error: "read the page but found no articles on it" }
}
