import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT_DIR } from '../src/config/env.js'

/**
 * The React app's static content modules. The backend reads them only for
 * seeding/importing — it never depends on them at runtime, so a standalone
 * backend deployment works without the frontend checked out beside it.
 */
export const FRONTEND_DATA_DIR = path.resolve(ROOT_DIR, '..', 'ghlprime-example', 'src', 'data')

export type ContentSourceType = 'blog' | 'caseStudy' | 'teamMember'

export interface ContentSource {
  file: string
  exportName: string
  type: ContentSourceType
}

/** Named content sources that can be imported by `scripts/import-content.ts`. */
export const CONTENT_SOURCES: Record<string, ContentSource> = {
  'blog-posts': { file: 'blogPosts.js', exportName: 'blogPosts', type: 'blog' },
  'july-blogs': { file: 'julyBlogPosts.js', exportName: 'julyBlogPosts', type: 'blog' },
  'keyword-blogs': { file: 'keywordBlogPosts.js', exportName: 'keywordBlogPosts', type: 'blog' },
  'case-studies': { file: 'caseStudies.js', exportName: 'caseStudies', type: 'caseStudy' },
  'team-members': { file: 'teamMembers.js', exportName: 'teamMembers', type: 'teamMember' },
}

/**
 * Imports an array export from a frontend data module.
 * Returns [] when the frontend is not present, so seeding never hard-fails in
 * a standalone deployment.
 */
export async function loadFrontendData<T = Record<string, unknown>>(file: string, exportName: string): Promise<T[]> {
  try {
    const moduleUrl = pathToFileURL(path.join(FRONTEND_DATA_DIR, file)).href
    const imported = (await import(moduleUrl)) as Record<string, unknown>
    const data = imported[exportName]

    return Array.isArray(data) ? (data as T[]) : []
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ERR_MODULE_NOT_FOUND') {
      console.warn(`   ! could not load ${file}: ${(error as Error).message}`)
    }
    return []
  }
}
