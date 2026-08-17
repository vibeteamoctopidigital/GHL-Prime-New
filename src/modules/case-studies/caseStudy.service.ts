import type { CaseStudy } from '@prisma/client'
import prisma from '../../config/prisma.js'
import BaseService from '../../shared/services/BaseService.js'
import { defaultSerializer } from '../../shared/serializers/caseTransform.js'
import { buildUniqueSlug } from '../../shared/utils/slug.js'
import ApiError from '../../shared/utils/ApiError.js'
import type { SerializedRow } from '../../types/common.js'

/** Mirrors the old Supabase embed: assigned_team_members -> team_member. */
const CASE_STUDY_INCLUDE = {
  assignedTeamMembers: {
    include: { teamMember: true },
    orderBy: { createdAt: 'asc' },
  },
} as const

export interface CaseStudyListOptions {
  category?: string | undefined
  search?: string | undefined
}

class CaseStudyService extends BaseService<CaseStudy> {
  constructor() {
    super({
      model: prisma.caseStudy,
      resourceName: 'Case study',
      defaultOrderBy: { createdAt: 'desc' },
      defaultInclude: CASE_STUDY_INCLUDE,
      searchableFields: ['title', 'category', 'excerpt', 'subtitle'],
      serialize: defaultSerializer,
    })
  }

  /** Published studies, newest first — the public /case-studies index. */
  listPublic({ category, search }: CaseStudyListOptions = {}): Promise<SerializedRow[]> {
    return this.list({
      where: { published: true, ...(category ? { category } : {}) },
      search,
    })
  }

  /** Every study including drafts — /admin/case-studies. */
  listAll({ search }: CaseStudyListOptions = {}): Promise<SerializedRow[]> {
    return this.list({ search })
  }

  /** Admins may preview drafts by slug; the public may not. */
  async findBySlug(slug: string, { includeUnpublished = false } = {}): Promise<SerializedRow> {
    const record = await this.findOne({ slug, ...(includeUnpublished ? {} : { published: true }) })
    if (!record) throw ApiError.notFound('Case study not found')
    return record
  }

  /** Replaces the study's team assignments in one transaction. */
  async syncTeamAssignments(caseStudyId: string, teamMemberIds: string[] = []): Promise<number> {
    const uniqueIds = [...new Set(teamMemberIds.filter(Boolean))]

    await prisma.$transaction([
      prisma.caseStudyTeamMember.deleteMany({ where: { caseStudyId } }),
      ...(uniqueIds.length > 0
        ? [
            prisma.caseStudyTeamMember.createMany({
              data: uniqueIds.map((teamMemberId) => ({ caseStudyId, teamMemberId })),
              skipDuplicates: true,
            }),
          ]
        : []),
    ])

    return uniqueIds.length
  }

  override async create(data: Record<string, unknown>): Promise<SerializedRow> {
    const { teamMemberIds = [], ...studyData } = data as { teamMemberIds?: string[] } & Record<string, unknown>

    const slug =
      (studyData['slug'] as string | undefined) ||
      (await buildUniqueSlug(studyData['title'], (candidate) => this.exists({ slug: candidate }), 'case-study'))

    const created = await super.create({ ...studyData, slug })
    await this.syncTeamAssignments(created['id'] as string, teamMemberIds)

    return this.findByIdOrFail(created['id'] as string)
  }

  override async update(id: string, data: Record<string, unknown>): Promise<SerializedRow> {
    const { teamMemberIds, ...studyData } = data as { teamMemberIds?: string[] } & Record<string, unknown>

    const slug = studyData['slug'] as string | undefined
    if (slug && (await this.exists({ slug, NOT: { id } }))) {
      throw ApiError.conflict('Another case study already uses this slug')
    }

    await super.update(id, studyData)
    if (teamMemberIds !== undefined) await this.syncTeamAssignments(id, teamMemberIds)

    return this.findByIdOrFail(id)
  }

  /** Distinct categories with a count — powers the case-study filter bar. */
  async listCategories(): Promise<{ category: string; count: number }[]> {
    const grouped = await prisma.caseStudy.groupBy({
      by: ['category'],
      where: { published: true },
      _count: { category: true },
      orderBy: { category: 'asc' },
    })

    return grouped.map((row) => ({ category: row.category, count: row._count.category }))
  }
}

export const caseStudyService = new CaseStudyService()
export default caseStudyService
