import type { BlogPost } from '@prisma/client'
import prisma from '../../config/prisma.js'
import BaseService from '../../shared/services/BaseService.js'
import { defaultSerializer } from '../../shared/serializers/caseTransform.js'
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

class BlogService extends BaseService<BlogPost> {
  constructor() {
    super({
      model: prisma.blogPost,
      resourceName: 'Blog post',
      defaultOrderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
      searchableFields: ['title', 'excerpt', 'category', 'content'],
      serialize: defaultSerializer,
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
    return this.list({ search, orderBy: { createdAt: 'desc' } })
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
      take: limit,
    })
  }

  /** Publishing a post for the first time stamps published_at. */
  private applyPublishedAt(data: Record<string, unknown>, existing: SerializedRow | null = null): Record<string, unknown> {
    if (data['published'] === true && !data['publishedAt'] && !existing?.['published_at']) {
      return { ...data, publishedAt: new Date() }
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
    const grouped = await prisma.blogPost.groupBy({
      by: ['category'],
      where: { published: true },
      _count: { category: true },
      orderBy: { category: 'asc' },
    })

    return grouped.map((row) => ({ category: row.category, count: row._count.category }))
  }
}

export const blogService = new BlogService()
export default blogService
