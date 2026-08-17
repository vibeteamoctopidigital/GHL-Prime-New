import { z } from 'zod'
import { DEFAULT_SORT_ORDER, PAGINATION } from '../../config/constants.js'

/** Trimmed string that treats '' as "not provided". */
export const optionalString = z
  .string()
  .trim()
  .optional()
  .nullable()
  .transform((value) => (value === '' ? null : value))

export const requiredString = (field = 'This field') =>
  z.string({ required_error: `${field} is required` }).trim().min(1, `${field} is required`)

export const optionalUrl = z
  .union([z.string().trim().url(), z.literal('')])
  .optional()
  .nullable()
  .transform((value) => (value ? value : null))

/** Accepts booleans and the string forms a form/query sends. */
export const booleanish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'])])
  .transform((value) => (typeof value === 'boolean' ? value : ['true', '1', 'yes', 'on'].includes(value)))

/**
 * Sort order: blank/invalid becomes 999, and never drops below 1 — matching the
 * frontend's normalizeOrderValue().
 *
 * An ABSENT field stays `undefined` rather than defaulting, which is what keeps
 * a partial update from silently resetting a row's position. The 999 default for
 * new rows is applied by SortableService.create instead.
 */
export const sortOrderSchema = z
  .union([z.number(), z.string(), z.null()])
  .optional()
  .transform((value): number | undefined => {
    if (value === undefined) return undefined
    if (value === '' || value === null) return DEFAULT_SORT_ORDER

    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return DEFAULT_SORT_ORDER

    return Math.max(1, Math.floor(parsed))
  })

export const uuidSchema = z.string().uuid('Must be a valid UUID')

export const idParamSchema = z.object({ id: uuidSchema })

export const slugParamSchema = z.object({
  slug: z.string().trim().min(1, 'Slug is required'),
})

export const searchQuerySchema = z
  .object({
    search: z.string().trim().optional(),
  })
  .passthrough()

export const paginationQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().default(PAGINATION.DEFAULT_PAGE),
    limit: z.coerce.number().int().positive().max(PAGINATION.MAX_LIMIT).default(PAGINATION.DEFAULT_LIMIT),
  })
  .passthrough()

/** Body shape for every PATCH /reorder endpoint. */
export const reorderSchema = z
  .object({
    items: z
      .array(
        z.object({
          id: uuidSchema,
          sort_order: z.coerce.number().int().optional(),
          sortOrder: z.coerce.number().int().optional(),
        }),
      )
      .min(1, 'At least one item is required'),
  })
  .transform(({ items }) => ({
    items: items.map((item) => ({
      id: item.id,
      sortOrder: item.sortOrder ?? item.sort_order ?? DEFAULT_SORT_ORDER,
    })),
  }))

export type ReorderBody = z.infer<typeof reorderSchema>
