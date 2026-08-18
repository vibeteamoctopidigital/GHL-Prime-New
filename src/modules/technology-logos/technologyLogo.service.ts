import SortableService from '../../shared/services/SortableService.js'

export const technologyLogoService = new SortableService({
  table: 'technology_logos',
  resourceName: 'Technology logo',
  searchableFields: ['name'],
})

export default technologyLogoService
