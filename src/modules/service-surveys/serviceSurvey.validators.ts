import { z } from 'zod'

const text = (max = 500) => z.string().trim().max(max).optional().default('')

/**
 * Mirrors the payload ServiceSurveyForm.buildPayload() produces, accepting both
 * the snake_case names it sends and camelCase equivalents.
 */
export const surveySubmitSchema = z
  .object({
    name: text(200),
    email: z.string().trim().email('Enter a valid email address'),
    phone: text(50),
    business: text(200),

    service: text(160),
    source: text(120),

    role: text(200),
    businessType: text(200),
    business_type: text(200),
    stage: text(200),
    appType: text(200),
    app_type: text(200),

    needs: text(5000),
    budget: text(120),

    subAccounts: text(120),
    sub_accounts: text(120),
    leadVolume: text(120),
    lead_volume: text(120),
    coverage: text(200),

    details: text(10_000),
    pageUrl: text(500),
    page_url: text(500),

    /** Honeypot: must stay empty. */
    website: text(500),
    formStartedAt: z.coerce.number().optional().default(0),
    form_started_at: z.coerce.number().optional().default(0),
  })
  .transform((input) => ({
    name: input.name,
    email: input.email,
    phone: input.phone,
    business: input.business,
    service: input.service,
    source: input.source,
    role: input.role,
    businessType: input.businessType || input.business_type || '',
    stage: input.stage,
    appType: input.appType || input.app_type || '',
    needs: input.needs,
    budget: input.budget,
    subAccounts: input.subAccounts || input.sub_accounts || '',
    leadVolume: input.leadVolume || input.lead_volume || '',
    coverage: input.coverage,
    details: input.details,
    pageUrl: input.pageUrl || input.page_url || '',
    website: input.website,
    formStartedAt: input.formStartedAt || input.form_started_at || 0,
  }))

export type SurveySubmitBody = z.infer<typeof surveySubmitSchema>
