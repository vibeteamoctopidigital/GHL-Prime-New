import supabase from '../../config/supabase.js'
import BaseService, { type BaseServiceOptions, type ListOptions } from './BaseService.js'
import ApiError from '../utils/ApiError.js'
import { DEFAULT_SORT_ORDER, SORTABLE_ORDER_BY } from '../../config/constants.js'
import type { ReorderItem, SerializedRow } from '../../types/common.js'

export interface SortableServiceOptions extends BaseServiceOptions {
  /**
   * Whether the table has a `published` column. `team_members` does not —
   * every row is public — so it passes false and `listPublic` degrades to
   * "all rows in display order".
   */
  publishable?: boolean
}

export interface ReorderResult {
  updated: number
}

/**
 * Base class for the many resources that share the same shape: a `published`
 * flag plus a manually-managed `sort_order` (logos, galleries, showcase stats,
 * team profiles...).
 */
export class SortableService extends BaseService {
  protected readonly publishable: boolean

  constructor({ publishable = true, ...options }: SortableServiceOptions) {
    super({ defaultOrderBy: SORTABLE_ORDER_BY, ...options })
    this.publishable = publishable
  }

  /** Published rows, in display order. Backs the public website. */
  listPublic(options: ListOptions = {}): Promise<SerializedRow[]> {
    if (!this.publishable) return this.list(options)
    return this.list({ ...options, where: { published: true, ...(options.where ?? {}) } })
  }

  /** Every row, in display order. Backs the admin panel. */
  listAll(options: ListOptions = {}): Promise<SerializedRow[]> {
    return this.list(options)
  }

  override create(data: Record<string, unknown>, options?: { select?: string }): Promise<SerializedRow> {
    return super.create({ sortOrder: DEFAULT_SORT_ORDER, ...data }, options)
  }

  /**
   * Persists a new ordering.
   *
   * PostgREST exposes no transactions, so this reads the affected rows, merges
   * the new positions, and writes them back in ONE upsert. That single request
   * becomes a single `INSERT ... ON CONFLICT DO UPDATE` statement, which
   * Postgres applies atomically — so the list is never observed half-reordered,
   * which N separate PATCHes could not guarantee.
   */
  async reorder(items: ReorderItem[] = []): Promise<ReorderResult> {
    if (items.length === 0) return { updated: 0 }

    const ids = items.map((item) => item.id)

    const { data: rows, error: readError } = await supabase.from(this.table).select('*').in('id', ids)
    if (readError) this.fail(`Could not reorder ${this.resourceName}`, readError)

    const found = rows ?? []
    const missing = ids.filter((id) => !found.some((row) => row['id'] === id))
    if (missing.length > 0) {
      throw ApiError.notFound(`${this.resourceName} not found: ${missing.join(', ')}`)
    }

    // Full rows are sent back so the INSERT half of the upsert satisfies every
    // NOT NULL column; only sort_order differs.
    const payload = found.map((row) => {
      const item = items.find((entry) => entry.id === row['id'])
      return { ...row, sort_order: Number(item?.sortOrder) || DEFAULT_SORT_ORDER }
    })

    const { error } = await supabase.from(this.table).upsert(payload, { onConflict: 'id' })
    if (error) this.fail(`Could not reorder ${this.resourceName}`, error)

    return { updated: payload.length }
  }
}

export default SortableService
