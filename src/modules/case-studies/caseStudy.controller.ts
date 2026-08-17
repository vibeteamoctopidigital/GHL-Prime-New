import type { RequestHandler } from 'express'
import asyncHandler from '../../shared/utils/asyncHandler.js'
import { sendCreated, sendOk } from '../../shared/utils/ApiResponse.js'
import sitemapService from '../sitemap/sitemap.service.js'
import caseStudyService from './caseStudy.service.js'
import type { CaseStudyListQuery } from './caseStudy.validators.js'

export const caseStudyController: Record<string, RequestHandler> = {
  /** GET / — published studies for the public index. */
  listPublic: asyncHandler(async (req, res) => {
    const { category, search } = req.query as CaseStudyListQuery
    const data = await caseStudyService.listPublic({ category, search })
    return sendOk(res, data, 'Case studies retrieved')
  }),

  /** GET /admin — every study, drafts included. */
  listAll: asyncHandler(async (req, res) => {
    const { search } = req.query as CaseStudyListQuery
    const data = await caseStudyService.listAll({ search })
    return sendOk(res, data, 'Case studies retrieved')
  }),

  /** GET /categories — filter bar counts. */
  listCategories: asyncHandler(async (_req, res) => {
    const data = await caseStudyService.listCategories()
    return sendOk(res, data, 'Case study categories retrieved')
  }),

  /** GET /slug/:slug — authenticated callers may preview drafts. */
  getBySlug: asyncHandler(async (req, res) => {
    const data = await caseStudyService.findBySlug(req.params['slug'] as string, {
      includeUnpublished: Boolean(req.user),
    })
    return sendOk(res, data, 'Case study retrieved')
  }),

  getById: asyncHandler(async (req, res) => {
    const data = await caseStudyService.findByIdOrFail(req.params['id'] as string)
    return sendOk(res, data, 'Case study retrieved')
  }),

  create: asyncHandler(async (req, res) => {
    const data = await caseStudyService.create(req.body as Record<string, unknown>)
    sitemapService.refreshInBackground()
    return sendCreated(res, { data, message: 'Case study created successfully' })
  }),

  update: asyncHandler(async (req, res) => {
    const data = await caseStudyService.update(req.params['id'] as string, req.body as Record<string, unknown>)
    sitemapService.refreshInBackground()
    return sendOk(res, data, 'Case study updated successfully')
  }),

  remove: asyncHandler(async (req, res) => {
    const data = await caseStudyService.remove(req.params['id'] as string)
    sitemapService.refreshInBackground()
    return sendOk(res, data, 'Case study deleted successfully')
  }),
}

export default caseStudyController
