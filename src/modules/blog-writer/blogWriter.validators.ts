import { z } from 'zod'

/** Matches BlogWriterSettings.categories' own default list, but isn't enforced as an enum — an admin's custom category should never be a validation error. */
export const createTopicSchema = z.object({
  title: z.string().trim().min(3, 'Topic needs at least 3 characters').max(200),
  target_keyword: z.string().trim().max(200).optional(),
  category: z.string().trim().max(100).optional(),
  research_mode: z.enum(['keyword', 'sources']).optional().default('keyword'),
})

/**
 * "Write next post" from the queue's top item, or an ad-hoc one-off typed
 * straight into the box. Exactly one of the two must be present — a request
 * always needs *something* to write about.
 */
export const createWriteRequestSchema = z
  .object({
    topic_id: z.string().uuid().optional(),
    ad_hoc_title: z.string().trim().min(3).max(200).optional(),
  })
  .refine((data) => Boolean(data.topic_id || data.ad_hoc_title), {
    message: 'Provide either topic_id or ad_hoc_title',
    path: ['topic_id'],
  })

export const listRequestsQuerySchema = z.object({
  status: z.enum(['pending', 'running', 'waiting', 'completed', 'failed']).optional(),
  limit: z.coerce.number().int().positive().max(100).optional().default(30),
  cursor: z.string().uuid().optional(),
})

export const createScheduleSchema = z.object({
  label: z.string().trim().min(1).max(200),
  hour: z.coerce.number().int().min(0).max(23).optional().default(6),
  minute: z.coerce.number().int().min(0).max(59).optional().default(0),
  days_of_week: z.array(z.coerce.number().int().min(0).max(6)).optional().default([]),
  keywords: z.array(z.string().trim().min(1)).min(1, 'Add at least one keyword'),
  posts_per_run: z.coerce.number().int().positive().max(20).optional().default(1),
  research_mode: z.enum(['keyword', 'sources']).optional().default('keyword'),
  category: z.string().trim().max(100).optional(),
  enabled: z.boolean().optional().default(true),
})

export const updateScheduleSchema = createScheduleSchema.partial()

export const updateSettingsSchema = z.object({
  auto_publish_enabled: z.boolean().optional(),
  default_model: z.string().trim().min(1).optional(),
  min_seo_score: z.coerce.number().int().min(0).max(100).optional(),
  max_internal_links: z.coerce.number().int().min(0).max(20).optional(),
  max_retries: z.coerce.number().int().min(0).max(20).optional(),
  run_timeout_minutes: z.coerce.number().int().min(1).max(120).optional(),
  style_rules: z.string().trim().optional(),
  categories: z.array(z.string().trim().min(1)).optional(),
  competitor_domains: z.array(z.string().trim().min(1)).optional(),
})
