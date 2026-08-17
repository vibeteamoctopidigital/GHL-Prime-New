import type { TechnologyLogo } from '@prisma/client'
import prisma from '../../config/prisma.js'
import SortableService from '../../shared/services/SortableService.js'
import { defaultSerializer } from '../../shared/serializers/caseTransform.js'

export const technologyLogoService = new SortableService<TechnologyLogo>({
  model: prisma.technologyLogo,
  resourceName: 'Technology logo',
  searchableFields: ['name'],
  serialize: defaultSerializer,
})

export default technologyLogoService
