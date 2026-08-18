import supabase from '../../config/supabase.js'
import SortableService from '../../shared/services/SortableService.js'
import ApiError from '../../shared/utils/ApiError.js'
import { DEFAULT_SORT_ORDER } from '../../config/constants.js'
import type { SerializedRow } from '../../types/common.js'

/** Embeds each item's placements, mirroring the old ORM include. */
const ITEM_SELECT = '*, placements:showcase_placements(*)'

export interface PlacementInput {
  pageKey: string
  sortOrder?: number
  enabled?: boolean
}

class ShowcaseItemService extends SortableService {
  constructor() {
    super({
      table: 'showcase_items',
      resourceName: 'Showcase item',
      searchableFields: ['origin_name', 'adaptation_name'],
      select: ITEM_SELECT,
    })
  }

  /**
   * Items placed on a page ('home', 'service:<slug>') in placement order.
   * Unpublished items are dropped, matching the old RLS behaviour.
   */
  async listForPage(pageKey: string): Promise<SerializedRow[]> {
    if (!pageKey) return []

    const { data, error } = await supabase
      .from('showcase_placements')
      .select(`sort_order, enabled, item:showcase_items!inner(${ITEM_SELECT})`)
      .eq('page_key', pageKey)
      .eq('enabled', true)
      .eq('showcase_items.published', true)
      .order('sort_order', { ascending: true })

    if (error) throw ApiError.internal(`Could not load showcase page: ${error.message}`)

    return (data ?? [])
      .map((row) => (row as Record<string, unknown>)['item'] as SerializedRow | null)
      .filter((item): item is SerializedRow => Boolean(item))
      .map((item) => this.serialize(item))
  }

  /**
   * Replaces an item's placements wholesale.
   *
   * PostgREST has no transactions, so this is a delete followed by an insert
   * rather than one atomic statement. The window between them is brief and the
   * insert is retried by nothing — if it fails the item is left with no
   * placements, which is visible and correctable, rather than silently
   * duplicated.
   */
  async syncPlacements(itemId: string, placements: PlacementInput[] = []): Promise<number> {
    const { error: deleteError } = await supabase.from('showcase_placements').delete().eq('item_id', itemId)
    if (deleteError) throw ApiError.internal(`Could not clear placements: ${deleteError.message}`)

    const rows = placements
      .filter((placement) => Boolean(placement?.pageKey))
      .map((placement) => ({
        item_id: itemId,
        page_key: placement.pageKey,
        sort_order: Number(placement.sortOrder) || DEFAULT_SORT_ORDER,
        enabled: placement.enabled !== false,
      }))

    if (rows.length === 0) return 0

    const { error } = await supabase.from('showcase_placements').insert(rows)
    if (error) throw ApiError.internal(`Could not set placements: ${error.message}`)

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
  table: 'showcase_stats',
  resourceName: 'Showcase stat',
  searchableFields: ['label', 'value'],
})
