import { z } from 'zod'
import defineResourceSchema from '../../shared/validators/defineResourceSchema.js'
import { optionalString, requiredString } from '../../shared/validators/common.validators.js'
import { DEFAULT_SORT_ORDER } from '../../config/constants.js'

/** One row of showcase_placements as the admin panel sends it. */
const placementSchema = z
  .object({
    page_key: z.string().trim().min(1).optional(),
    pageKey: z.string().trim().min(1).optional(),
    sort_order: z.coerce.number().int().optional(),
    sortOrder: z.coerce.number().int().optional(),
    enabled: z.boolean().optional(),
  })
  .refine((placement) => Boolean(placement.pageKey ?? placement.page_key), {
    message: 'page_key is required for a placement',
  })
  .transform((placement) => ({
    pageKey: (placement.pageKey ?? placement.page_key) as string,
    sortOrder: placement.sortOrder ?? placement.sort_order ?? DEFAULT_SORT_ORDER,
    enabled: placement.enabled !== false,
  }))

const placementsField = z.array(placementSchema).optional()

/** adaptation_tags is a JSON array of short labels ("RETAIL", "D2C"). */
const tagsField = z
  .union([z.array(z.string()), z.string()])
  .optional()
  .transform((value): string[] | undefined => {
    if (value === undefined) return undefined
    if (Array.isArray(value)) return value

    try {
      const parsed: unknown = JSON.parse(value)
      return Array.isArray(parsed) ? (parsed as string[]) : []
    } catch {
      return value
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean)
    }
  })

const itemSchemas = defineResourceSchema({
  fields: {
    originName: requiredString('Origin name'),
    originUrl: optionalString,
    originIcon: optionalString,
    originDescription: optionalString,
    originTagline: optionalString,
    adaptationBadge: optionalString,
    adaptationName: requiredString('Adaptation name'),
    adaptationDescription: optionalString,
    adaptationTags: tagsField,
    placements: placementsField,
  },
  required: ['originName', 'adaptationName'],
})

const statSchemas = defineResourceSchema({
  fields: {
    value: requiredString('Value'),
    label: requiredString('Label'),
  },
  required: ['value', 'label'],
})

export const pageKeyParamSchema = z.object({ pageKey: z.string().trim().min(1) })

export const createShowcaseItemSchema = itemSchemas.createSchema
export const updateShowcaseItemSchema = itemSchemas.updateSchema
export const createShowcaseStatSchema = statSchemas.createSchema
export const updateShowcaseStatSchema = statSchemas.updateSchema
