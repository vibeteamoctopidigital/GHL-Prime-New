import SortableService from '../../shared/services/SortableService.js'
import type { SerializedRow } from '../../types/common.js'

/**
 * The stored column is company_name, but the frontend reads "name" on some
 * screens and "company_name" on others. Emitting both keeps every consumer
 * working without touching the React code.
 *
 * The live table also carries two empty legacy columns (name, logo_image_url)
 * from an earlier schema; "name" is overwritten here so a stale NULL never
 * shadows the real value.
 */
const serialize = (row: SerializedRow): SerializedRow => ({
  ...row,
  name: (row['company_name'] as string) ?? '',
  company_name: (row['company_name'] as string) ?? '',
})

export const partnerLogoService = new SortableService({
  table: 'partner_logos',
  resourceName: 'Partner logo',
  searchableFields: ['company_name'],
  serialize,
})

export default partnerLogoService
