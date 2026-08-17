import createCrudRouter from '../../shared/factories/createCrudRouter.js'
import defineResourceSchema from '../../shared/validators/defineResourceSchema.js'
import { optionalString, requiredString } from '../../shared/validators/common.validators.js'
import meetingGalleryService from './meetingGallery.service.js'

const { createSchema, updateSchema } = defineResourceSchema({
  fields: {
    title: optionalString,
    imageUrl: requiredString('Image URL'),
  },
  required: ['imageUrl'],
})

export default createCrudRouter({
  service: meetingGalleryService,
  label: 'Meeting gallery item',
  createSchema,
  updateSchema,
})
