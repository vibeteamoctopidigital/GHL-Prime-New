import SortableService from '../../shared/services/SortableService.js'

export const meetingGalleryService = new SortableService({
  table: 'meeting_gallery',
  resourceName: 'Meeting gallery item',
  searchableFields: ['title'],
})

export default meetingGalleryService
