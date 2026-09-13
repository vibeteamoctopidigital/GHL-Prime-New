import prisma from '../../config/prisma.js'
import SortableService from '../../shared/services/SortableService.js'

export const technologyLogoService = new SortableService({
  model: prisma.technologyLogo,
  resourceName: 'Technology logo',
  searchableFields: ['name'],
})

export default technologyLogoService
