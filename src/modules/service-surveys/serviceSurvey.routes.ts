import createLeadRouter from '../../shared/factories/createLeadRouter.js'
import authenticate from '../../shared/middleware/authenticate.js'
import { authorizeContentManager } from '../../shared/middleware/authorize.js'
import asyncHandler from '../../shared/utils/asyncHandler.js'
import { sendOk } from '../../shared/utils/ApiResponse.js'
import serviceSurveyService from './serviceSurvey.service.js'
import { surveySubmitSchema, type SurveySubmitBody } from './serviceSurvey.validators.js'

/**
 * POST /service-surveys/submit      — public, from any /services/* page
 * GET  /service-surveys/submissions — admin inbox
 */
const router = createLeadRouter({
  service: serviceSurveyService,
  submitSchema: surveySubmitSchema,
  submit: (body: SurveySubmitBody) => serviceSurveyService.submit(body),
  label: 'Service survey',
  inboxPath: '/submissions',
})

/** Which service pages actually produce leads. */
router.get(
  '/by-service',
  authenticate,
  authorizeContentManager,
  asyncHandler(async (_req, res) => {
    const data = await serviceSurveyService.countsByService()
    return sendOk(res, data, 'Service survey counts retrieved')
  }),
)

export default router
