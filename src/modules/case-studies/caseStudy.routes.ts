import { Router, type RequestHandler } from 'express'
import validate from '../../shared/middleware/validate.js'
import authenticate, { optionalAuthenticate } from '../../shared/middleware/authenticate.js'
import { authorizeContentManager } from '../../shared/middleware/authorize.js'
import { idParamSchema, slugParamSchema } from '../../shared/validators/common.validators.js'
import caseStudyController from './caseStudy.controller.js'
import { caseStudyListQuerySchema, createCaseStudySchema, updateCaseStudySchema } from './caseStudy.validators.js'

const router = Router()
const guard: RequestHandler[] = [authenticate, authorizeContentManager]

router.get('/', validate({ query: caseStudyListQuerySchema }), caseStudyController.listPublic!)
router.get('/admin', ...guard, validate({ query: caseStudyListQuerySchema }), caseStudyController.listAll!)
router.get('/categories', caseStudyController.listCategories!)

// Literal segments must precede '/:id'.
router.get('/slug/:slug', optionalAuthenticate, validate({ params: slugParamSchema }), caseStudyController.getBySlug!)

router.post('/', ...guard, validate({ body: createCaseStudySchema }), caseStudyController.create!)

router.get('/:id', validate({ params: idParamSchema }), caseStudyController.getById!)
router.put('/:id', ...guard, validate({ params: idParamSchema, body: updateCaseStudySchema }), caseStudyController.update!)
router.patch('/:id', ...guard, validate({ params: idParamSchema, body: updateCaseStudySchema }), caseStudyController.update!)
router.delete('/:id', ...guard, validate({ params: idParamSchema }), caseStudyController.remove!)

export default router
