import type { RequestHandler } from 'express'
import asyncHandler from '../../shared/utils/asyncHandler.js'
import { sendCreated, sendOk } from '../../shared/utils/ApiResponse.js'
import sitemapService from '../sitemap/sitemap.service.js'
import blogService from './blog.service.js'
import type { BlogListQuery, RelatedQuery } from './blog.validators.js'

export const blogController: Record<string, RequestHandler> = {
  /** GET / — published posts. Returns a paginated envelope when ?page is set. */
  listPublic: asyncHandler(async (req, res) => {
    const query = req.query as BlogListQuery

    if (query.page !== undefined || query.limit !== undefined) {
      const { data, meta } = await blogService.listPublicPaginated(query)
      return sendOk(res, data, 'Blog posts retrieved', meta)
    }

    const data = await blogService.listPublic(query)
    return sendOk(res, data, 'Blog posts retrieved')
  }),

  listAll: asyncHandler(async (req, res) => {
    const data = await blogService.listAll({ search: req.query['search'] as string | undefined })
    return sendOk(res, data, 'Blog posts retrieved')
  }),

  getBySlug: asyncHandler(async (req, res) => {
    const data = await blogService.findBySlug(req.params['slug'] as string, { includeUnpublished: Boolean(req.user) })
    return sendOk(res, data, 'Blog post retrieved')
  }),

  getById: asyncHandler(async (req, res) => {
    const data = await blogService.findByIdOrFail(req.params['id'] as string)
    return sendOk(res, data, 'Blog post retrieved')
  }),

  /** GET /related?category=&exclude=&limit= */
  listRelated: asyncHandler(async (req, res) => {
    const { category, exclude, limit } = req.query as unknown as RelatedQuery
    const data = await blogService.listRelated(category, exclude, limit)
    return sendOk(res, data, 'Related posts retrieved')
  }),

  listCategories: asyncHandler(async (_req, res) => {
    const data = await blogService.listCategories()
    return sendOk(res, data, 'Blog categories retrieved')
  }),

  create: asyncHandler(async (req, res) => {
    const data = await blogService.create(req.body as Record<string, unknown>)
    sitemapService.refreshInBackground()
    return sendCreated(res, { data, message: 'Blog post created successfully' })
  }),

  update: asyncHandler(async (req, res) => {
    const data = await blogService.update(req.params['id'] as string, req.body as Record<string, unknown>)
    sitemapService.refreshInBackground()
    return sendOk(res, data, 'Blog post updated successfully')
  }),

  remove: asyncHandler(async (req, res) => {
    const data = await blogService.remove(req.params['id'] as string)
    sitemapService.refreshInBackground()
    return sendOk(res, data, 'Blog post deleted successfully')
  }),
}

export default blogController
