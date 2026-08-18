import env from '../../config/env.js'
import LeadService from '../../shared/services/LeadService.js'
import logger from '../../shared/utils/logger.js'
import type { SerializedRow } from '../../types/common.js'
import type { ContactSubmitBody } from './contact.validators.js'

export interface SpamOutcome {
  ok: true
  spam: true
}

class ContactService extends LeadService {
  constructor() {
    super({
      table: 'contact_leads',
      resourceName: 'Contact lead',
      webhookUrl: env.CONTACT_WEBHOOK_URL,
      searchableFields: ['full_name', 'email', 'company', 'message'],
    })
  }

  /**
   * Persists the lead, then forwards it to the CRM.
   *
   * The multi-step ContactPage collects far more than the original
   * `contact_leads` columns held (it posted straight to the webhook), so every
   * qualifying answer is stored here too.
   */
  async submit(input: ContactSubmitBody): Promise<SerializedRow | SpamOutcome> {
    if (this.isSpam(input)) {
      logger.info('Contact submission rejected as spam')
      return { ok: true, spam: true }
    }

    const submittedAt = new Date()

    const row = {
      fullName: input.fullName || null,
      email: input.email || null,
      phone: input.phone || null,
      company: input.company || null,
      message: input.message || null,
      source: input.source || 'ghlprime.com/contact',
      country: input.country || null,
      role: input.role || null,
      ghlSituation: input.ghlSituation || null,
      clientVolume: input.clientVolume || null,
      monthlyBudget: input.monthlyBudget || null,
      timeline: input.timeline || null,
      biggestChallenge: input.biggestChallenge || null,
      pageUrl: input.pageUrl || null,
      submittedAt: submittedAt.toISOString(),
    }

    // The webhook keeps the exact field names the CRM automation expects.
    const webhookPayload = {
      source: row.source,
      submitted_at: submittedAt.toISOString(),
      name: row.fullName,
      email: row.email,
      business_name: row.company,
      country: row.country,
      phone: row.phone,
      role: row.role,
      ghl_situation: row.ghlSituation,
      client_volume: row.clientVolume,
      monthly_budget: row.monthlyBudget,
      timeline: row.timeline,
      biggest_challenge: row.biggestChallenge,
      message: row.message,
    }

    return this.persistAndForward(row, webhookPayload)
  }
}

export const contactService = new ContactService()
export default contactService
