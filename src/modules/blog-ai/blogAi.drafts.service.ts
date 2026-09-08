import supabase from '../../config/supabase.js'
import ApiError from '../../shared/utils/ApiError.js'
import blogService from '../blog/blog.service.js'
import type { CheckerResult, DraftStatus } from './blogAi.validators.js'
import type { SerializedRow } from '../../types/common.js'



const PUBLISHABLE_STATUSES: DraftStatus[] = ['pending_review', 'checker_failed']

class BlogAiDraftsService {
  async list(status?: DraftStatus, limit = 50): Promise<SerializedRow[]> {
    let query = supabase
      .from('blog_ai_drafts')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit)

    if (status) query = query.eq('status', status)

    const { data, error } = await query
    if (error) throw ApiError.internal(`Could not list drafts: ${error.message}`)
    return (data ?? []) as unknown as SerializedRow[]
  }

  async findOrFail(id: string): Promise<SerializedRow> {
    const { data, error } = await supabase.from('blog_ai_drafts').select('*').eq('id', id).maybeSingle()
    if (error) throw ApiError.internal(`Could not load draft: ${error.message}`)
    if (!data) throw ApiError.notFound('Draft not found')
    return data as unknown as SerializedRow
  }


  async publishDraft(draft: SerializedRow, reviewedBy: string | null = null): Promise<SerializedRow> {
    const post = await blogService.create({
      title: draft['title'],
      slug: draft['slug'],
      category: draft['category'],
      tags: draft['tags'],
      excerpt: draft['excerpt'],
      content: draft['content'],
      seoTitle: draft['seo_title'],
      seoDescription: draft['seo_description'],
      seoKeywords: draft['seo_keywords'],
      readingTime: draft['reading_time'],
      coverImage: draft['cover_image'] ?? undefined,
      author: 'GHL Prime Team',
      featured: false,
      published: true,
    })

    const { data: updated, error } = await supabase
      .from('blog_ai_drafts')
      .update({
        status: 'published',
        blog_post_id: post['id'],
        reviewed_by: reviewedBy,
        reviewed_at: reviewedBy ? new Date().toISOString() : (draft['reviewed_at'] ?? null),
      })
      .eq('id', draft['id'])
      .select('*')
      .single()

    if (error) throw ApiError.internal(`Post was created but the draft record could not be updated: ${error.message}`)

    if (draft['run_id']) {
      await supabase.from('blog_ai_runs').update({ blog_post_id: post['id'] }).eq('id', draft['run_id'] as string)
    }

    return updated as unknown as SerializedRow
  }

  async approveDraft(id: string, adminUserId: string): Promise<SerializedRow> {
    const draft = await this.findOrFail(id)
    if (!PUBLISHABLE_STATUSES.includes(draft['status'] as DraftStatus)) {
      throw ApiError.conflict(`Draft cannot be approved from status "${String(draft['status'])}"`)
    }

    return this.publishDraft(draft, adminUserId)
  }

  async rejectDraft(id: string, adminUserId: string): Promise<SerializedRow> {
    const draft = await this.findOrFail(id)
    if (!PUBLISHABLE_STATUSES.includes(draft['status'] as DraftStatus)) {
      throw ApiError.conflict(`Draft cannot be rejected from status "${String(draft['status'])}"`)
    }

    const { data, error } = await supabase
      .from('blog_ai_drafts')
      .update({ status: 'rejected', reviewed_by: adminUserId, reviewed_at: new Date().toISOString() })
      .eq('id', id)
      .select('*')
      .single()

    if (error) throw ApiError.internal(`Could not reject draft: ${error.message}`)
    return data as unknown as SerializedRow
  }

  /** Drafts whose review window has passed with no admin action yet. */
  async listExpiredPendingDrafts(): Promise<SerializedRow[]> {
    const { data, error } = await supabase
      .from('blog_ai_drafts')
      .select('*')
      .eq('status', 'pending_review')
      .lt('review_deadline', new Date().toISOString())

    if (error) throw ApiError.internal(`Could not list expired drafts: ${error.message}`)
    return (data ?? []) as unknown as SerializedRow[]
  }

  /**
   * Atomically flips pending_review -> checking, filtered on the CURRENT
   * status in the same query — returns null if something else already
   * claimed it (e.g. an overlapping sweep run), so the checker never
   * double-processes the same draft.
   */
  async claimForChecking(id: string): Promise<SerializedRow | null> {
    const { data, error } = await supabase
      .from('blog_ai_drafts')
      .update({ status: 'checking' })
      .eq('id', id)
      .eq('status', 'pending_review')
      .select('*')
      .maybeSingle()

    if (error) throw ApiError.internal(`Could not claim draft for checking: ${error.message}`)
    return data as unknown as SerializedRow | null
  }

  async markCheckerFailed(id: string, outcome: { result?: CheckerResult; skippedReason?: string }): Promise<void> {
    const { error } = await supabase
      .from('blog_ai_drafts')
      .update({ status: 'checker_failed', checker_result: outcome.result ?? { reason: outcome.skippedReason } })
      .eq('id', id)

    if (error) throw ApiError.internal(`Could not mark draft as checker_failed: ${error.message}`)
  }
}

export const blogAiDraftsService = new BlogAiDraftsService()
export default blogAiDraftsService
