import { Router } from 'express'
import { z } from 'zod'
import createCrudRouter from '../../shared/factories/createCrudRouter.js'
import defineResourceSchema from '../../shared/validators/defineResourceSchema.js'
import { optionalString, requiredString, uuidSchema } from '../../shared/validators/common.validators.js'
import asyncHandler from '../../shared/utils/asyncHandler.js'
import { sendOk } from '../../shared/utils/ApiResponse.js'
import validate from '../../shared/middleware/validate.js'
import { galleryCategoryService, galleryImageService } from './gallery.service.js'

// --- Categories -------------------------------------------------------------
const categorySchemas = defineResourceSchema({
  fields: {
    name: requiredString('Name'),
    slug: optionalString,
  },
  required: ['name'],
})

// --- Images -----------------------------------------------------------------
const imageSchemas = defineResourceSchema({
  fields: {
    title: optionalString,
    imageUrl: requiredString('Image URL'),
    categoryId: uuidSchema.nullable().optional(),
  },
  required: ['imageUrl'],
})

const categoriesRouter = createCrudRouter({
  service: galleryCategoryService,
  label: 'Gallery category',
  createSchema: categorySchemas.createSchema,
  updateSchema: categorySchemas.updateSchema,
})

const imagesRouter = createCrudRouter({
  service: galleryImageService,
  label: 'Gallery image',
  createSchema: imageSchemas.createSchema,
  updateSchema: imageSchemas.updateSchema,
  // Registered before '/:id' so "by-category" is not read as an id.
  extend: (router) => {
    router.get(
      '/by-category/:categoryId',
      validate({ params: z.object({ categoryId: uuidSchema }) }),
      asyncHandler(async (req, res) => {
        const data = await galleryImageService.listByCategory(req.params['categoryId'] as string)
        return sendOk(res, data, 'Gallery images retrieved')
      }),
    )
  },
})

const router = Router()

router.use('/categories', categoriesRouter)
router.use('/images', imagesRouter)

/** Convenience endpoint: everything /gallery needs in one round trip. */
router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const [categories, images] = await Promise.all([
      galleryCategoryService.listPublic(),
      galleryImageService.listPublic(),
    ])

    return sendOk(res, { categories, images }, 'Gallery retrieved')
  }),
)

export default router
