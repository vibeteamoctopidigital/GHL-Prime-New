import createLeadRouter from '../../shared/factories/createLeadRouter.js'
import createModuleIndex from '../../shared/factories/createModuleIndex.js'
import contactService from './contact.service.js'
import { contactSubmitSchema, type ContactSubmitBody } from './contact.validators.js'

/**
 * POST /contact/submit      — public contact form
 * GET  /contact/leads       — admin inbox (list, stats, detail, status, delete)
 */
const router = createLeadRouter({
  service: contactService,
  submitSchema: contactSubmitSchema,
  submit: (body: ContactSubmitBody) => contactService.submit(body),
  label: 'Contact lead',
  inboxPath: '/leads',
})

/** GET /contact — lists what lives under this prefix. */
router.get(
  '/',
  createModuleIndex('/contact', [
    { method: 'POST', path: '/submit', description: 'Public contact form submission' },
    { method: 'GET', path: '/leads', description: 'Lead inbox, paginated (auth)' },
    { method: 'GET', path: '/leads/stats', description: 'Counts per status (auth)' },
    { method: 'GET', path: '/leads/:id', description: 'One lead (auth)' },
    { method: 'PATCH', path: '/leads/:id/status', description: 'Move through the pipeline (auth)' },
    { method: 'DELETE', path: '/leads/:id', description: 'Delete a lead (auth)' },
  ]),
)

export default router
