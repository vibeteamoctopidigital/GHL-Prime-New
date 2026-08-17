import createLeadRouter from '../../shared/factories/createLeadRouter.js'
import contactService from './contact.service.js'
import { contactSubmitSchema, type ContactSubmitBody } from './contact.validators.js'

/**
 * POST /contact/submit      — public contact form
 * GET  /contact/leads       — admin inbox (list, stats, detail, status, delete)
 */
export default createLeadRouter({
  service: contactService,
  submitSchema: contactSubmitSchema,
  submit: (body: ContactSubmitBody) => contactService.submit(body),
  label: 'Contact lead',
  inboxPath: '/leads',
})
