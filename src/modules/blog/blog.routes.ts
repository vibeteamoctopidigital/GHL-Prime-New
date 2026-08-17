import { Router, type RequestHandler } from 'express'
import validate from '../../shared/middleware/validate.js'
import authenticate, { optionalAuthenticate } from '../../shared/middleware/authenticate.js'
import { authorizeContentManager } from '../../shared/middleware/authorize.js'
import { idParamSchema, slugParamSchema } from '../../shared/validators/common.validators.js'
import blogController from './blog.controller.js'
import { blogListQuerySchema, createBlogPostSchema, relatedQuerySchema, updateBlogPostSchema } from './blog.validators.js'

const router = Router()
const guard: RequestHandler[] = [authenticate, authorizeContentManager]

router.get('/', validate({ query: blogListQuerySchema }), blogController.listPublic!)
router.get('/admin', ...guard, validate({ query: blogListQuerySchema }), blogController.listAll!)
router.get('/categories', blogController.listCategories!)
router.get('/related', validate({ query: relatedQuerySchema }), blogController.listRelated!)
router.get('/slug/:slug', optionalAuthenticate, validate({ params: slugParamSchema }), blogController.getBySlug!)

router.post('/', ...guard, validate({ body: createBlogPostSchema }), blogController.create!)

router.get('/:id', validate({ params: idParamSchema }), blogController.getById!)
router.put('/:id', ...guard, validate({ params: idParamSchema, body: updateBlogPostSchema }), blogController.update!)
router.patch('/:id', ...guard, validate({ params: idParamSchema, body: updateBlogPostSchema }), blogController.update!)
router.delete('/:id', ...guard, validate({ params: idParamSchema }), blogController.remove!)

export default router
