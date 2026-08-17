import type { ShowcaseItem, ShowcaseStat } from '@prisma/client'
import prisma from '../../config/prisma.js'
import SortableService from '../../shared/services/SortableService.js'
import { defaultSerializer } from '../../shared/serializers/caseTransform.js'
import { DEFAULT_SORT_ORDER } from '../../config/constants.js'
import type { SerializedRow } from '../../types/common.js'

const ITEM_INCLUDE = { placements: true } as const

export interface PlacementInput {
  pageKey: string
  sortOrder?: number
  enabled?: boolean
}

class ShowcaseItemService extends SortableService<ShowcaseItem> {
  constructor() {
    super({
      model: prisma.showcaseItem,
      resourceName: 'Showcase item',
      searchableFields: ['originName', 'adaptationName'],
      defaultInclude: ITEM_INCLUDE,
      serialize: defaultSerializer,
    })
  }

  /**
   * Items placed on a page ('home', 'service:<slug>') in placement order.
   * Unpublished items are dropped, matching the old RLS behaviour.
   */
  async listForPage(pageKey: string): Promise<SerializedRow[]> {
    if (!pageKey) return []

    const rows = await prisma.showcasePlacement.findMany({
      where: { pageKey, enabled: true, item: { published: true } },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: { item: { include: ITEM_INCLUDE } },
    })

    return rows.map((row) => this.serialize(row.item))
  }

  /**
   * Replaces an item's placements wholesale (delete-then-insert), inside a
   * transaction so the item is never briefly placed nowhere.
   */
  async syncPlacements(itemId: string, placements: PlacementInput[] = []): Promise<number> {
    const rows = placements
      .filter((placement) => Boolean(placement?.pageKey))
      .map((placement) => ({
        itemId,
        pageKey: placement.pageKey,
        sortOrder: Number(placement.sortOrder) || DEFAULT_SORT_ORDER,
        enabled: placement.enabled !== false,
      }))

    await prisma.$transaction([
      prisma.showcasePlacement.deleteMany({ where: { itemId } }),
      ...(rows.length > 0 ? [prisma.showcasePlacement.createMany({ data: rows, skipDuplicates: true })] : []),
    ])

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
}

export const showcaseItemService = new ShowcaseItemService()

export const showcaseStatService = new SortableService<ShowcaseStat>({
  model: prisma.showcaseStat,
  resourceName: 'Showcase stat',
  searchableFields: ['label', 'value'],
  serialize: defaultSerializer,
})
