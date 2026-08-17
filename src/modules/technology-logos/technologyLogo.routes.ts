import createCrudRouter from '../../shared/factories/createCrudRouter.js'
import defineResourceSchema from '../../shared/validators/defineResourceSchema.js'
import { requiredString } from '../../shared/validators/common.validators.js'
import technologyLogoService from './technologyLogo.service.js'

const { createSchema, updateSchema } = defineResourceSchema({
  fields: {
    name: requiredString('Name'),
    imageUrl: requiredString('Image URL'),
  },
  required: ['name', 'imageUrl'],
})

export default createCrudRouter({
  service: technologyLogoService,
  label: 'Technology logo',
  createSchema,
  updateSchema,
})
