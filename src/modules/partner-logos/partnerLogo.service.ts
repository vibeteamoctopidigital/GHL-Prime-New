import type { PartnerLogo } from '@prisma/client'
import prisma from '../../config/prisma.js'
import SortableService from '../../shared/services/SortableService.js'
import { toSnakeCase } from '../../shared/serializers/caseTransform.js'
import type { SerializedRow } from '../../types/common.js'

/**
 * The stored column is `company_name`, but the frontend reads `name` on some
 * screens and `company_name` on others. Emitting both keeps every consumer
 * working without touching the React code.
 */
const serialize = (row: PartnerLogo): SerializedRow => ({
  ...toSnakeCase<SerializedRow>(row),
  name: row.companyName ?? '',
  company_name: row.companyName ?? '',
})

export const partnerLogoService = new SortableService<PartnerLogo>({
  model: prisma.partnerLogo,
  resourceName: 'Partner logo',
  searchableFields: ['companyName'],
  serialize,
})

export default partnerLogoService
