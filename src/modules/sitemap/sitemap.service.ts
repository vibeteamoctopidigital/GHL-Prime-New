import fs from 'node:fs/promises'
import path from 'node:path'
import env from '../../config/env.js'
import caseStudyService from '../case-studies/caseStudy.service.js'
import blogService from '../blog/blog.service.js'
import logger from '../../shared/utils/logger.js'

export interface SitemapRoute {
  path: string
  changefreq: string
  priority: string
  lastmod?: string | undefined
}

/** Always-present marketing routes, ported from api/refresh-sitemap.js. */
const STATIC_ROUTES: SitemapRoute[] = [
  { path: '/', changefreq: 'weekly', priority: '1.0' },
  { path: '/services', changefreq: 'weekly', priority: '0.9' },
  { path: '/about', changefreq: 'monthly', priority: '0.8' },
  { path: '/team', changefreq: 'monthly', priority: '0.8' },
  { path: '/booking', changefreq: 'weekly', priority: '0.9' },
  { path: '/case-studies', changefreq: 'weekly', priority: '0.8' },
  { path: '/blog', changefreq: 'weekly', priority: '0.8' },
  { path: '/gallery', changefreq: 'monthly', priority: '0.6' },
  { path: '/contact', changefreq: 'monthly', priority: '0.7' },
  { path: '/faq', changefreq: 'monthly', priority: '0.6' },
]

const XML_ESCAPES: Record<string, string> = {
  '<': '&lt;',
  '>': '&gt;',
  '&': '&amp;',
  "'": '&apos;',
  '"': '&quot;',
}

const escapeXml = (value: string): string => String(value).replace(/[<>&'"]/g, (char) => XML_ESCAPES[char] ?? char)

function buildXml(routes: SitemapRoute[]): string {
  const urls = routes
    .map((route) => {
      const loc = `${env.SITE_URL}${route.path === '/' ? '' : route.path}`
      const lastmod = route.lastmod ? `\n    <lastmod>${route.lastmod}</lastmod>` : ''

      return `  <url>
    <loc>${escapeXml(loc)}</loc>${lastmod}
    <changefreq>${route.changefreq}</changefreq>
    <priority>${route.priority}</priority>
  </url>`
    })
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`
}

const toIso = (value: string | Date | null | undefined): string | undefined => (value ? new Date(value).toISOString() : undefined)

export interface SitemapRefreshResult {
  count: number
  /** Null when nothing was written to disk (serverless). */
  outputDir: string | null
  written: boolean
  /** How the sitemap is being served, so callers understand the result. */
  mode: 'file' | 'dynamic'
}

class SitemapService {
  /** Collects published case studies and blog posts into route entries. */
  async collectRoutes(): Promise<SitemapRoute[]> {
    const [studies, posts] = await Promise.all([
      caseStudyService.listPublishedSlugs(),
      blogService.listPublishedSlugs(),
    ])

    const seen = new Set<string>()
    const dynamicRoutes: SitemapRoute[] = []

    const add = (prefix: string, rows: { slug: string; updated_at: string }[], priority: string): void => {
      for (const row of rows) {
        if (!row.slug?.trim()) continue

        const routePath = `${prefix}/${row.slug}`
        if (seen.has(routePath)) continue
        seen.add(routePath)

        dynamicRoutes.push({ path: routePath, changefreq: 'monthly', priority, lastmod: toIso(row.updated_at) })
      }
    }

    add('/case-studies', studies, '0.7')
    add('/blog', posts, '0.7')

    return [...STATIC_ROUTES, ...dynamicRoutes]
  }

  /** Returns the sitemap XML without writing it to disk. */
  async generateXml(): Promise<string> {
    return buildXml(await this.collectRoutes())
  }

  /**
   * Writes public/sitemap.xml and reports how many URLs it contains.
   *
   * On serverless the filesystem is read-only, and a pre-written file would go
   * stale the moment content changed anyway. There the sitemap is served live
   * from `GET /sitemap.xml`, so this reports the count without writing.
   */
  async refresh(): Promise<SitemapRefreshResult> {
    const routes = await this.collectRoutes()

    if (env.isServerless) {
      logger.info(`Sitemap generated dynamically: ${routes.length} URLs (read-only filesystem, nothing written)`)
      return { count: routes.length, outputDir: null, written: false, mode: 'dynamic' }
    }

    await fs.mkdir(env.sitemapOutputDir, { recursive: true })
    await fs.writeFile(path.join(env.sitemapOutputDir, 'sitemap.xml'), buildXml(routes), 'utf8')

    logger.info(`Sitemap refreshed: ${routes.length} URLs -> ${env.sitemapOutputDir}`)
    return { count: routes.length, outputDir: env.sitemapOutputDir, written: true, mode: 'file' }
  }

  /**
   * Fire-and-forget refresh used after content mutations. A failing sitemap
   * write must never turn a successful save into an error response.
   *
   * Skipped on serverless: work queued after the response is not guaranteed to
   * run there, and with the sitemap served dynamically there is nothing to do.
   */
  refreshInBackground(): void {
    if (env.isServerless) return

    this.refresh().catch((error: unknown) => {
      logger.warn('Background sitemap refresh failed:', error instanceof Error ? error.message : error)
    })
  }
}

export const sitemapService = new SitemapService()
export default sitemapService
