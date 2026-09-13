/**
 * Regenerates public/sitemap.xml from the database.
 * The build-time equivalent of POST /api/sitemap/refresh, replacing the old
 * scripts/generate-sitemap.mjs that read from Supabase.
 *
 *   npm run sitemap:refresh
 */

import { disconnectDatabase } from '../src/config/prisma.js'
import sitemapService from '../src/modules/sitemap/sitemap.service.js'

try {
  const { count, outputDir } = await sitemapService.refresh()
  console.log(`Sitemap written: ${count} URLs -> ${outputDir}`)
} catch (error) {
  console.error('Sitemap refresh failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  await disconnectDatabase()
}
