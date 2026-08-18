import supabase from '../../config/supabase.js'
import BaseService from '../../shared/services/BaseService.js'
import { buildUniqueSlug } from '../../shared/utils/slug.js'
import ApiError from '../../shared/utils/ApiError.js'
import { getPagination } from '../../shared/utils/pagination.js'
import type { PaginatedResult, SerializedRow } from '../../types/common.js'

export interface BlogListOptions {
  category?: string | undefined
  search?: string | undefined
  featured?: boolean | undefined
  page?: number | undefined
  limit?: number | undefined
}

class BlogService extends BaseService {
  constructor() {
    super({
      table: 'blog_posts',
      resourceName: 'Blog post',
      defaultOrderBy: [
        { column: 'published_at', ascending: false },
        { column: 'created_at', ascending: false },
      ],
      searchableFields: ['title', 'excerpt', 'category', 'content'],
    })
  }

  private publicWhere({ category, featured }: BlogListOptions): Record<string, unknown> {
    return {
      published: true,
      ...(category ? { category } : {}),
      ...(featured !== undefined ? { featured } : {}),
    }
  }

  /** Published posts, newest first. */
  listPublic(options: BlogListOptions = {}): Promise<SerializedRow[]> {
    return this.list({ where: this.publicWhere(options), search: options.search })
  }

  /** Same, with pagination metadata — used when ?page/?limit is present. */
  listPublicPaginated(options: BlogListOptions = {}): Promise<PaginatedResult<SerializedRow>> {
    const { page, limit } = getPagination({ page: options.page, limit: options.limit })
    return this.listPaginated({ where: this.publicWhere(options), search: options.search, page, limit })
  }

  /** Every post including drafts, newest-created first — /admin/blog. */
  listAll({ search }: { search?: string | undefined } = {}): Promise<SerializedRow[]> {
    return this.list({ search, orderBy: [{ column: 'created_at', ascending: false }] })
  }

  async findBySlug(slug: string, { includeUnpublished = false } = {}): Promise<SerializedRow> {
    const record = await this.findOne({ slug, ...(includeUnpublished ? {} : { published: true }) })
    if (!record) throw ApiError.notFound('Blog post not found')
    return record
  }

  /** Same-category posts, excluding the one being read. */
  listRelated(category: string, excludeSlug?: string, limit = 3): Promise<SerializedRow[]> {
    if (!category) return Promise.resolve([])

    return this.list({
      where: { published: true, category, ...(excludeSlug ? { NOT: { slug: excludeSlug } } : {}) },
      limit,
    })
  }

  /** Publishing a post for the first time stamps published_at. */
  private applyPublishedAt(
    data: Record<string, unknown>,
    existing: SerializedRow | null = null,
  ): Record<string, unknown> {
    if (data['published'] === true && !data['publishedAt'] && !existing?.['published_at']) {
      return { ...data, publishedAt: new Date().toISOString() }
    }
    return data
  }

  override async create(data: Record<string, unknown>): Promise<SerializedRow> {
    const slug =
      (data['slug'] as string | undefined) ||
      (await buildUniqueSlug(data['title'], (candidate) => this.exists({ slug: candidate }), 'post'))

    return super.create(this.applyPublishedAt({ ...data, slug }))
  }

  override async update(id: string, data: Record<string, unknown>): Promise<SerializedRow> {
    const slug = data['slug'] as string | undefined

    if (slug && (await this.exists({ slug, NOT: { id } }))) {
      throw ApiError.conflict('Another blog post already uses this slug')
    }

    const existing = await this.findByIdOrFail(id)
    return super.update(id, this.applyPublishedAt(data, existing))
  }

  /** Distinct categories with a post count — powers the blog filter bar. */
  async listCategories(): Promise<{ category: string; count: number }[]> {
    const { data, error } = await supabase.from('blog_posts').select('category').eq('published', true)
    if (error) throw ApiError.internal(`Could not load categories: ${error.message}`)

    const counts = new Map<string, number>()
    for (const row of data ?? []) {
      const category = (row as { category: string }).category
      if (category) counts.set(category, (counts.get(category) ?? 0) + 1)
    }

    return [...counts.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => a.category.localeCompare(b.category))
  }

  /** Slug + updated_at for every published post — used to build the sitemap. */
  async listPublishedSlugs(): Promise<{ slug: string; updated_at: string }[]> {
    const { data, error } = await supabase
      .from('blog_posts')
      .select('slug, updated_at')
      .eq('published', true)
      .order('published_at', { ascending: false })

    if (error) throw ApiError.internal(`Could not load blog slugs: ${error.message}`)
    return (data ?? []) as { slug: string; updated_at: string }[]
  }
}

export const blogService = new BlogService()
export default blogService
