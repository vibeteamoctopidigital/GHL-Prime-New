import { z } from 'zod'

const text = (max = 500) => z.string().trim().max(max).optional().default('')

/**
 * Accepts both the original api/contact-submit.js payload (fullName, company,
 * message) and the richer multi-step ContactPage payload (name, business_name,
 * ghl_situation, ...), since both shapes are in use.
 */
export const contactSubmitSchema = z
  .object({
    fullName: text(200),
    full_name: text(200),
    name: text(200),

    email: z.string().trim().email('Enter a valid email address'),
    phone: text(50),

    company: text(200),
    business: text(200),
    business_name: text(200),

    message: text(5000),
    source: text(120),

    country: text(80),
    role: text(200),

    ghlSituation: text(2000),
    ghl_situation: text(2000),
    clientVolume: text(120),
    client_volume: text(120),
    monthlyBudget: text(120),
    monthly_budget: text(120),
    timeline: text(120),
    biggestChallenge: text(2000),
    biggest_challenge: text(2000),

    pageUrl: text(500),
    page_url: text(500),

    /** Honeypot: must stay empty. */
    website: text(500),
    formStartedAt: z.coerce.number().optional().default(0),
    form_started_at: z.coerce.number().optional().default(0),
  })
  .transform((input) => ({
    fullName: input.fullName || input.full_name || input.name || '',
    email: input.email,
    phone: input.phone,
    company: input.company || input.business || input.business_name || '',
    message: input.message,
    source: input.source,
    country: input.country,
    role: input.role,
    ghlSituation: input.ghlSituation || input.ghl_situation || '',
    clientVolume: input.clientVolume || input.client_volume || '',
    monthlyBudget: input.monthlyBudget || input.monthly_budget || '',
    timeline: input.timeline,
    biggestChallenge: input.biggestChallenge || input.biggest_challenge || '',
    pageUrl: input.pageUrl || input.page_url || '',
    website: input.website,
    formStartedAt: input.formStartedAt || input.form_started_at || 0,
  }))

export type ContactSubmitBody = z.infer<typeof contactSubmitSchema>
