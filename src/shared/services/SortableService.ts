import prisma from '../../config/prisma.js'
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

  override create(data: Record<string, unknown>, options?: { select?: string[] }): Promise<SerializedRow> {
    return super.create({ sortOrder: DEFAULT_SORT_ORDER, ...data }, options)
  }

  /**
   * Persists a new ordering as one real database transaction.
   *
   * The previous PostgREST implementation relied on a single bulk
   * `INSERT ... ON CONFLICT DO UPDATE` for atomicity, since PostgREST itself
   * has no transaction support. Prisma does, so this is now N per-row
   * updates wrapped in `$transaction` — same atomicity guarantee (the list
   * is never observed half-reordered), simpler to read, and it no longer
   * needs to round-trip full rows just to satisfy an upsert's NOT NULL
   * columns the way the old approach did.
   */
  async reorder(items: ReorderItem[] = []): Promise<ReorderResult> {
    if (items.length === 0) return { updated: 0 }

    const ids = items.map((item) => item.id)
    const found: { id: string }[] = await this.model.findMany({ where: { id: { in: ids } }, select: { id: true } })

    const foundIds = new Set(found.map((row) => row.id))
    const missing = ids.filter((id) => !foundIds.has(id))
    if (missing.length > 0) {
      throw ApiError.notFound(`${this.resourceName} not found: ${missing.join(', ')}`)
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PrismaModelDelegate's loose typing doesn't carry the real PrismaPromise type $transaction expects; the runtime objects are the genuine Prisma client's, so this is safe.
      await prisma.$transaction(
        items.map((item) =>
          this.model.update({
            where: { id: item.id },
            data: { sort_order: Number(item.sortOrder) || DEFAULT_SORT_ORDER },
          }),
        ) as any[],
      )
    } catch (error) {
      this.fail(`Could not reorder ${this.resourceName}`, error)
    }

    return { updated: items.length }
  }
}

export default SortableService
