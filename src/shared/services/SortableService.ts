import prisma from '../../config/prisma.js'
import BaseService, { type BaseServiceOptions, type ListOptions } from './BaseService.js'
import { DEFAULT_SORT_ORDER, SORTABLE_ORDER_BY } from '../../config/constants.js'
import type { ReorderItem, SerializedRow } from '../../types/common.js'

export interface SortableServiceOptions<TRow> extends BaseServiceOptions<TRow> {
  /**
   * Whether the model has a `published` column. `team_members` does not —
   * every row is public — so it passes false and `listPublic` degrades to
   * "all rows in display order".
   */
  publishable?: boolean
}

export interface ReorderResult {
  updated: number
}

/**
 * Base class for the many resources that share the exact same shape:
 * a `published` flag plus a manually-managed `sortOrder`
 * (logos, galleries, showcase stats, team profiles...).
 */
export class SortableService<TRow extends { id: string }> extends BaseService<TRow> {
  protected readonly publishable: boolean

  constructor({ publishable = true, ...options }: SortableServiceOptions<TRow>) {
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

  override create(
    data: Record<string, unknown>,
    options?: { include?: Record<string, unknown> },
  ): Promise<SerializedRow> {
    return super.create({ sortOrder: DEFAULT_SORT_ORDER, ...data }, options)
  }

  /**
   * Persists a new ordering in a single transaction, so the list is never
   * observed half-reordered.
   */
  async reorder(items: ReorderItem[] = []): Promise<ReorderResult> {
    if (items.length === 0) return { updated: 0 }

    await prisma.$transaction(
      items.map(({ id, sortOrder }) =>
        this.model.update({ where: { id }, data: { sortOrder: Number(sortOrder) || DEFAULT_SORT_ORDER } }),
      ) as never,
    )

    return { updated: items.length }
  }
}

export default SortableService
