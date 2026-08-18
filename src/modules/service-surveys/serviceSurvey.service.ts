import env from '../../config/env.js'
import LeadService from '../../shared/services/LeadService.js'
import logger from '../../shared/utils/logger.js'
import type { SerializedRow } from '../../types/common.js'
import type { SurveySubmitBody } from './serviceSurvey.validators.js'

export interface SpamOutcome {
  ok: true
  spam: true
}

/**
 * Submissions from the multi-step forms on every /services/* page
 * (ServiceSurveyForm.jsx). These previously went straight to the CRM webhook
 * and were never stored, so the admin panel had no record of them.
 */
class ServiceSurveyService extends LeadService {
  constructor() {
    super({
      table: 'service_surveys',
      resourceName: 'Service survey',
      // Falls back to the contact webhook, which is where these already went.
      webhookUrl: env.SURVEY_WEBHOOK_URL || env.CONTACT_WEBHOOK_URL,
      searchableFields: ['name', 'email', 'business', 'service', 'needs', 'details'],
    })
  }

  async submit(input: SurveySubmitBody): Promise<SerializedRow | SpamOutcome> {
    if (this.isSpam(input)) {
      logger.info('Service survey submission rejected as spam')
      return { ok: true, spam: true }
    }

    const submittedAt = new Date()

    const row = {
      name: input.name || null,
      email: input.email || null,
      phone: input.phone || null,
      business: input.business || null,
      service: input.service || null,
      source: input.source || 'Service page survey',
      role: input.role || null,
      businessType: input.businessType || null,
      stage: input.stage || null,
      appType: input.appType || null,
      needs: input.needs || null,
      budget: input.budget || null,
      subAccounts: input.subAccounts || null,
      leadVolume: input.leadVolume || null,
      coverage: input.coverage || null,
      details: input.details || null,
      pageUrl: input.pageUrl || null,
      submittedAt: submittedAt.toISOString(),
    }

    // Field names match exactly what ServiceSurveyForm already posted, so the
    // existing CRM automation keeps working untouched.
    const webhookPayload = {
      name: row.name,
      email: row.email,
      phone: row.phone,
      business: row.business,
      role: row.role,
      business_type: row.businessType,
      stage: row.stage,
      app_type: row.appType,
      needs: row.needs,
      budget: row.budget,
      sub_accounts: row.subAccounts,
      lead_volume: row.leadVolume,
      coverage: row.coverage,
      service: row.service,
      source: row.source,
      details: row.details,
      page_url: row.pageUrl,
      submitted_at: submittedAt.toISOString(),
    }

    return this.persistAndForward(row, webhookPayload)
  }

  /** Submission counts per service page — which pages actually convert. */
  async countsByService(): Promise<{ service: string; count: number }[]> {
    const rows = await this.list({ select: 'service' })

    const counts = new Map<string, number>()
    for (const row of rows) {
      const service = row['service'] as string | null
      if (service) counts.set(service, (counts.get(service) ?? 0) + 1)
    }

    return [...counts.entries()]
      .map(([service, count]) => ({ service, count }))
      .sort((a, b) => a.service.localeCompare(b.service))
  }
}

export const serviceSurveyService = new ServiceSurveyService()
export default serviceSurveyService
