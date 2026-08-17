import { z } from 'zod'
import { booleanish, optionalString, uuidSchema } from '../../shared/validators/common.validators.js'

/** `body` is a JSON array of rich-text blocks (strings or objects). */
const bodyField = z
  .union([z.array(z.any()), z.string()])
  .optional()
  .transform((value): unknown[] | undefined => {
    if (value === undefined) return undefined
    if (Array.isArray(value)) return value

    try {
      const parsed: unknown = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : [value]
    } catch {
      return [value]
    }
  })

const teamMemberIdsField = z.array(uuidSchema).optional()

const baseShape = {
  title: z.string().trim().min(1, 'Title is required').optional(),
  slug: optionalString,
  category: z.string().trim().min(1, 'Category is required').optional(),
  subtitle: optionalString,
  challenge: optionalString,
  solution: optionalString,
  outcome: optionalString,
  excerpt: optionalString,
  image: optionalString,
  accent: optionalString,
  body: bodyField,
  featured: booleanish.optional(),
  published: booleanish.optional(),
  teamMemberIds: teamMemberIdsField,
  team_member_ids: teamMemberIdsField,
}

const base = z.object(baseShape)

const normalize = ({ team_member_ids: snakeIds, teamMemberIds, ...rest }: z.infer<typeof base>): Record<string, unknown> => {
  const ids = teamMemberIds ?? snakeIds
  return { ...rest, ...(ids !== undefined ? { teamMemberIds: ids } : {}) }
}

export const createCaseStudySchema = base
  .refine((data) => Boolean(data.title), { message: 'Title is required', path: ['title'] })
  .refine((data) => Boolean(data.category), { message: 'Category is required', path: ['category'] })
  .transform(normalize)

export const updateCaseStudySchema = base.transform(normalize)

export const caseStudyListQuerySchema = z
  .object({
    category: z.string().trim().optional(),
    search: z.string().trim().optional(),
  })
  .passthrough()

export type CaseStudyListQuery = z.infer<typeof caseStudyListQuerySchema>
