import prisma from '../../config/prisma.js'
import BaseService from '../../shared/services/BaseService.js'
import { buildUniqueSlug } from '../../shared/utils/slug.js'
import ApiError from '../../shared/utils/ApiError.js'
import type { SerializedRow } from '../../types/common.js'

/** Mirrors the old Supabase embed: assigned_team_members -> team_member. */
const CASE_STUDY_INCLUDE = { assigned_team_members: { include: { team_member: true } } }

export interface CaseStudyListOptions {
  category?: string | undefined
  search?: string | undefined
}

class CaseStudyService extends BaseService {
  constructor() {
    super({
      model: prisma.caseStudy,
      resourceName: 'Case study',
      defaultOrderBy: [{ column: 'created_at', ascending: false }],
      include: CASE_STUDY_INCLUDE,
      searchableFields: ['title', 'category', 'excerpt', 'subtitle'],
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

  /**
   * Replaces the study's team assignments as one real transaction — an
   * upgrade from the previous delete-then-insert pair, which PostgREST
   * couldn't wrap atomically. A failure now can't leave the study with no
   * credits at all; it either fully replaces the assignments or changes
   * nothing.
   */
  async syncTeamAssignments(caseStudyId: string, teamMemberIds: string[] = []): Promise<number> {
    const uniqueIds = [...new Set(teamMemberIds.filter(Boolean))]

    try {
      await prisma.$transaction([
        prisma.caseStudyTeamMember.deleteMany({ where: { case_study_id: caseStudyId } }),
        ...(uniqueIds.length > 0
          ? [
              prisma.caseStudyTeamMember.createMany({
                data: uniqueIds.map((teamMemberId) => ({ case_study_id: caseStudyId, team_member_id: teamMemberId })),
              }),
            ]
          : []),
      ])
    } catch (error) {
      throw ApiError.internal(`Could not sync team assignments: ${error instanceof Error ? error.message : String(error)}`)
    }

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
    const rows: { category: string }[] = await prisma.caseStudy.findMany({
      where: { published: true },
      select: { category: true },
    })

    const counts = new Map<string, number>()
    for (const row of rows) {
      if (row.category) counts.set(row.category, (counts.get(row.category) ?? 0) + 1)
    }

    return [...counts.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => a.category.localeCompare(b.category))
  }

  /** Slug + updated_at for every published study — used to build the sitemap. */
  async listPublishedSlugs(): Promise<{ slug: string; updated_at: string }[]> {
    const rows: { slug: string; updated_at: Date }[] = await prisma.caseStudy.findMany({
      where: { published: true },
      select: { slug: true, updated_at: true },
      orderBy: { created_at: 'desc' },
    })

    return rows.map((row) => ({ slug: row.slug, updated_at: row.updated_at.toISOString() }))
  }
}

export const caseStudyService = new CaseStudyService()
export default caseStudyService
