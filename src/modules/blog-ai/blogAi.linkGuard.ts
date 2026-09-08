/**
 * Deterministic content-safety pass, run on every generated post regardless
 * of whether the model followed the prompt's link/heading rules — the same
 * "defense in depth" principle as textSanitize.ts's em-dash stripping.
 * Nothing here trusts the model to have gotten it right; it enforces it.
 */

export interface LinkGuardResult {
  html: string
  internalLinkCount: number
  externalLinkCount: number
  strippedCompetitorLinks: string[]
  strippedExcessInternalLinks: number
  demotedH1Count: number
}

const ANCHOR_PATTERN = /<a\b[^>]*\bhref\s*=\s*["']([^"']*)["'][^>]*>(.*?)<\/a>/gis

function isInternalHref(href: string, siteUrl: string): boolean {
  if (href.startsWith('/') || href.startsWith('#')) return true

  try {
    const siteHost = new URL(siteUrl).hostname.replace(/^www\./, '')
    const linkHost = new URL(href, siteUrl).hostname.replace(/^www\./, '')
    return linkHost === siteHost
  } catch {
    return false
  }
}

function matchesCompetitorDomain(href: string, competitorDomains: string[]): string | null {
  let linkHost: string
  try {
    linkHost = new URL(href).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return null // relative/malformed URLs can't be a competitor's external domain
  }

  return (
    competitorDomains.find((domain) => {
      const cleaned = domain.trim().replace(/^www\./, '').toLowerCase()
      return cleaned && (linkHost === cleaned || linkHost.endsWith(`.${cleaned}`))
    }) ?? null
  )
}

/**
 * Strips any link to a competitor domain (unwraps to plain text — the
 * sentence stays readable, just not clickable) and caps internal links at
 * `maxInternalLinks` (unwrapping the excess, keeping the first N). External,
 * non-competitor links are left untouched.
 */
export function guardLinks(html: string, opts: { siteUrl: string; competitorDomains: string[]; maxInternalLinks: number }): LinkGuardResult {
  let internalSeen = 0
  let internalLinkCount = 0
  let externalLinkCount = 0
  let strippedExcessInternalLinks = 0
  const strippedCompetitorLinks: string[] = []

  const html1 = html.replace(ANCHOR_PATTERN, (whole, href: string, inner: string) => {
    const competitor = matchesCompetitorDomain(href, opts.competitorDomains)
    if (competitor) {
      strippedCompetitorLinks.push(href)
      return inner
    }

    if (isInternalHref(href, opts.siteUrl)) {
      internalSeen += 1
      if (internalSeen > opts.maxInternalLinks) {
        strippedExcessInternalLinks += 1
        return inner
      }
      internalLinkCount += 1
      return whole
    }

    externalLinkCount += 1
    return whole
  })

  // Defense in depth: the prompt already says content must never contain an
  // <h1> (the post title is the page's only one) — downgrade any that slip
  // through instead of trusting that instruction alone.
  let demotedH1Count = 0
  const html2 = html1.replace(/<h1(\s[^>]*)?>/gi, () => {
    demotedH1Count += 1
    return '<h2>'
  })
  const html3 = html2.replace(/<\/h1>/gi, '</h2>')

  return {
    html: html3,
    internalLinkCount,
    externalLinkCount,
    strippedCompetitorLinks,
    strippedExcessInternalLinks,
    demotedH1Count,
  }
}

export default guardLinks
