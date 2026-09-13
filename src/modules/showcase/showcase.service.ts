import prisma from '../../config/prisma.js'
import SortableService from '../../shared/services/SortableService.js'
import ApiError from '../../shared/utils/ApiError.js'
import { DEFAULT_SORT_ORDER } from '../../config/constants.js'
import type { SerializedRow } from '../../types/common.js'

/** Embeds each item's placements, mirroring the old ORM include. */
const ITEM_INCLUDE = { placements: true }

export interface PlacementInput {
  pageKey: string
  sortOrder?: number
  enabled?: boolean
}

class ShowcaseItemService extends SortableService {
  constructor() {
    super({
      model: prisma.showcaseItem,
      resourceName: 'Showcase item',
      searchableFields: ['origin_name', 'adaptation_name'],
      include: ITEM_INCLUDE,
    })
  }

  /**
   * Items placed on a page ('home', 'service:<slug>') in placement order.
   * Unpublished items are dropped, matching the old RLS behaviour — modeled
   * here as an inner join via Prisma's required (non-nullable) relation
   * filter, same as the old `!inner` PostgREST embed.
   */
  async listForPage(pageKey: string): Promise<SerializedRow[]> {
    if (!pageKey) return []

    const placements = await prisma.showcasePlacement.findMany({
      where: { page_key: pageKey, enabled: true, item: { published: true } },
      orderBy: { sort_order: 'asc' },
      include: { item: { include: ITEM_INCLUDE } },
    })

    return placements.map((placement) => this.serialize(placement.item as unknown as SerializedRow))
  }

  /**
   * Replaces an item's placements wholesale, as one real transaction — an
   * upgrade from the previous delete-then-insert pair, which PostgREST
   * couldn't wrap atomically.
   */
  async syncPlacements(itemId: string, placements: PlacementInput[] = []): Promise<number> {
    const rows = placements
      .filter((placement) => Boolean(placement?.pageKey))
      .map((placement) => ({
        item_id: itemId,
        page_key: placement.pageKey,
        sort_order: Number(placement.sortOrder) || DEFAULT_SORT_ORDER,
        enabled: placement.enabled !== false,
      }))

    try {
      await prisma.$transaction([
        prisma.showcasePlacement.deleteMany({ where: { item_id: itemId } }),
        ...(rows.length > 0 ? [prisma.showcasePlacement.createMany({ data: rows })] : []),
      ])
    } catch (error) {
      throw ApiError.internal(`Could not set placements: ${error instanceof Error ? error.message : String(error)}`)
    }

    return rows.length
  }

  override async create(data: Record<string, unknown>): Promise<SerializedRow> {
    const { placements = [], ...itemData } = data as { placements?: PlacementInput[] } & Record<string, unknown>

    const created = await super.create(itemData)
    await this.syncPlacements(created['id'] as string, placements)

    return this.findByIdOrFail(created['id'] as string)
  }

  override async update(id: string, data: Record<string, unknown>): Promise<SerializedRow> {
    const { placements, ...itemData } = data as { placements?: PlacementInput[] } & Record<string, unknown>

    await super.update(id, itemData)
    // `undefined` means "leave placements alone"; `[]` means "clear them".
    if (placements !== undefined) await this.syncPlacements(id, placements)

    return this.findByIdOrFail(id)
  }

  /** Placements cascade in the database, so only the item is deleted here. */
  override async remove(id: string) {
    return super.remove(id)
  }
}

export const showcaseItemService = new ShowcaseItemService()

export const showcaseStatService = new SortableService({
  model: prisma.showcaseStat,
  resourceName: 'Showcase stat',
  searchableFields: ['label', 'value'],
})
