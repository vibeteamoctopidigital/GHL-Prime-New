import env from '../../../config/env.js'

/**
 * What counts as "our own site", and which of its pages exist as files.
 *
 * The importer checks every internal link in a draft against real pages, and
 * the audit counts links to us separately from links away. Both need to know
 * our host and our static routes. The dynamic ones (/blog/<slug>,
 * /case-studies/<slug>) are resolved against the database by the caller.
 *
 * The frontend is a separate repository, so its routes cannot be read off disk
 * the way octopi's importer does. This list is the app/ directory of
 * ghlprime-updated as of the port; a page added there needs a line here or the
 * importer will hold a post that links to it.
 */

const OWN_HOST = /(^|\.)ghlprime\.com$/i

export function isOwnHost(hostname: string): boolean {
  if (!hostname) return false
  if (OWN_HOST.test(hostname)) return true
  try {
    return new URL(env.SITE_URL).hostname.toLowerCase() === hostname.toLowerCase()
  } catch {
    return false
  }
}

/** Static pages of the public site. Keep in step with ghlprime-updated/src/app. */
export const STATIC_ROUTES: readonly string[] = [
  '/',
  '/about',
  '/blog',
  '/booking',
  '/case-studies',
  '/contact',
  '/faq',
  '/gallery',
  '/hire-an-individual',
  '/privacy-policy',
  '/services',
  '/team',
  '/terms',
]

/**
 * The service pages, with the label a link to each should carry. These are
 * what the posts exist to sell, so the writer is always handed the whole list.
 */
export const SERVICE_PAGES: readonly { url: string; label: string }[] = [
  { url: '/services/ghl-setup', label: 'GHL Setup & Configuration' },
  { url: '/services/automation', label: 'Workflow Automation' },
  { url: '/services/saas-crm', label: 'SaaS CRM Launch' },
  { url: '/services/white-label-support', label: 'White-Label Support' },
  { url: '/services/vibe-coding', label: 'Vibe Coding' },
  { url: '/services/ai-agent-builder', label: 'AI Agent Builder' },
  { url: '/services/custom-saas-development', label: 'Custom SaaS Development' },
  { url: '/services/figma-to-code', label: 'Figma to Code' },
  { url: '/services/app-development', label: 'App Development' },
  { url: '/services/saas-customer-support', label: 'SaaS Customer Support' },
]

export const STATIC_ROUTE_SET: ReadonlySet<string> = new Set([
  ...STATIC_ROUTES,
  ...SERVICE_PAGES.map((page) => page.url),
])
