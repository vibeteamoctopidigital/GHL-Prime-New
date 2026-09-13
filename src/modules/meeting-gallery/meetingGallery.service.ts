import prisma from '../../config/prisma.js'
import SortableService from '../../shared/services/SortableService.js'

export const meetingGalleryService = new SortableService({
  model: prisma.meetingGallery,
  resourceName: 'Meeting gallery item',
  searchableFields: ['title'],
})

export default meetingGalleryService
