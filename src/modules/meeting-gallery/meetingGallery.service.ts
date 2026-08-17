import type { MeetingGalleryItem } from '@prisma/client'
import prisma from '../../config/prisma.js'
import SortableService from '../../shared/services/SortableService.js'
import { defaultSerializer } from '../../shared/serializers/caseTransform.js'

export const meetingGalleryService = new SortableService<MeetingGalleryItem>({
  model: prisma.meetingGalleryItem,
  resourceName: 'Meeting gallery item',
  searchableFields: ['title'],
  serialize: defaultSerializer,
})

export default meetingGalleryService
