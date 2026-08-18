import supabase from '../../config/supabase.js'
import BaseService from '../../shared/services/BaseService.js'
import { buildUniqueSlug } from '../../shared/utils/slug.js'
import ApiError from '../../shared/utils/ApiError.js'
import type { SerializedRow } from '../../types/common.js'

/** Mirrors the old Supabase embed: assigned_team_members -> team_member. */
const CASE_STUDY_SELECT = '*, assigned_team_members:case_study_team_members(*, team_member:team_members(*))'

export interface CaseStudyListOptions {
  category?: string | undefined
  search?: string | undefined
}

class CaseStudyService extends BaseService {
  constructor() {
    super({
      table: 'case_studies',
      resourceName: 'Case study',
      defaultOrderBy: [{ column: 'created_at', ascending: false }],
      select: CASE_STUDY_SELECT,
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
   * Replaces the study's team assignments.
   *
   * Delete-then-insert; PostgREST cannot wrap the pair in a transaction, so a
   * failure between them leaves the study with no credits rather than
   * duplicates — visible and correctable.
   */
  async syncTeamAssignments(caseStudyId: string, teamMemberIds: string[] = []): Promise<number> {
    const { error: deleteError } = await supabase
      .from('case_study_team_members')
      .delete()
      .eq('case_study_id', caseStudyId)

    if (deleteError) throw ApiError.internal(`Could not clear team assignments: ${deleteError.message}`)

    const uniqueIds = [...new Set(teamMemberIds.filter(Boolean))]
    if (uniqueIds.length === 0) return 0

    const { error } = await supabase
      .from('case_study_team_members')
      .insert(uniqueIds.map((teamMemberId) => ({ case_study_id: caseStudyId, team_member_id: teamMemberId })))

    if (error) throw ApiError.internal(`Could not assign team members: ${error.message}`)

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
    const { data, error } = await supabase.from('case_studies').select('category').eq('published', true)
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

  /** Slug + updated_at for every published study — used to build the sitemap. */
  async listPublishedSlugs(): Promise<{ slug: string; updated_at: string }[]> {
    const { data, error } = await supabase
      .from('case_studies')
      .select('slug, updated_at')
      .eq('published', true)
      .order('created_at', { ascending: false })

    if (error) throw ApiError.internal(`Could not load case study slugs: ${error.message}`)
    return (data ?? []) as { slug: string; updated_at: string }[]
  }
}

export const caseStudyService = new CaseStudyService()
export default caseStudyService
