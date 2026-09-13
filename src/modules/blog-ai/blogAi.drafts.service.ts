import prisma from '../../config/prisma.js'
import ApiError from '../../shared/utils/ApiError.js'
import blogService from '../blog/blog.service.js'
import type { CheckerResult, DraftStatus } from './blogAi.validators.js'
import type { SerializedRow } from '../../types/common.js'

const PUBLISHABLE_STATUSES: DraftStatus[] = ['pending_review', 'checker_failed']

/** True for Prisma's "record to update not found" error (P2025). */
const isPrismaNotFound = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'P2025'

class BlogAiDraftsService {
  async list(status?: DraftStatus, limit = 50): Promise<SerializedRow[]> {
    const rows = await prisma.blogAiDraft.findMany({
      where: status ? { status } : {},
      orderBy: { created_at: 'desc' },
      take: limit,
    })

    return rows as unknown as SerializedRow[]
  }

  async findOrFail(id: string): Promise<SerializedRow> {
    const row = await prisma.blogAiDraft.findUnique({ where: { id } })
    if (!row) throw ApiError.notFound('Draft not found')
    return row as unknown as SerializedRow
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

    let updated: SerializedRow
    try {
      updated = (await prisma.blogAiDraft.update({
        where: { id: draft['id'] as string },
        data: {
          status: 'published',
          blog_post_id: post['id'] as string,
          reviewed_by: reviewedBy,
          reviewed_at: reviewedBy ? new Date() : ((draft['reviewed_at'] as Date | null) ?? null),
        },
      })) as unknown as SerializedRow
    } catch (error) {
      throw ApiError.internal(`Post was created but the draft record could not be updated: ${error instanceof Error ? error.message : String(error)}`)
    }

    if (draft['run_id']) {
      await prisma.blogAiRun.update({ where: { id: draft['run_id'] as string }, data: { blog_post_id: post['id'] as string } })
    }

    return updated
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

    try {
      const updated = await prisma.blogAiDraft.update({
        where: { id },
        data: { status: 'rejected', reviewed_by: adminUserId, reviewed_at: new Date() },
      })
      return updated as unknown as SerializedRow
    } catch (error) {
      throw ApiError.internal(`Could not reject draft: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Drafts whose review window has passed with no admin action yet. */
  async listExpiredPendingDrafts(): Promise<SerializedRow[]> {
    const rows = await prisma.blogAiDraft.findMany({
      where: { status: 'pending_review', review_deadline: { lt: new Date() } },
    })

    return rows as unknown as SerializedRow[]
  }

  /**
   * Atomically flips pending_review -> checking, filtered on the CURRENT
   * status in the same query — returns null if something else already
   * claimed it (e.g. an overlapping sweep run), so the checker never
   * double-processes the same draft.
   *
   * Prisma's `update()` requires a unique `where` (just `id` here), so the
   * status condition can't ride along in the same call the way PostgREST's
   * `.eq('status', ...)` did — `updateMany()` (which allows any `where`)
   * plus checking its `count` preserves the same atomicity: the UPDATE...WHERE
   * still runs as one statement at the database level, so a concurrent sweep
   * can still only ever win this race once.
   */
  async claimForChecking(id: string): Promise<SerializedRow | null> {
    const { count } = await prisma.blogAiDraft.updateMany({
      where: { id, status: 'pending_review' },
      data: { status: 'checking' },
    })

    if (count === 0) return null
    return this.findOrFail(id)
  }

  async markCheckerFailed(id: string, outcome: { result?: CheckerResult; skippedReason?: string }): Promise<void> {
    try {
      await prisma.blogAiDraft.update({
        where: { id },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CheckerResult / {reason} are plain JSON-serializable objects, matching the `Json` column.
        data: { status: 'checker_failed', checker_result: (outcome.result ?? { reason: outcome.skippedReason }) as any },
      })
    } catch (error) {
      if (isPrismaNotFound(error)) return
      throw ApiError.internal(`Could not mark draft as checker_failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

export const blogAiDraftsService = new BlogAiDraftsService()
export default blogAiDraftsService
