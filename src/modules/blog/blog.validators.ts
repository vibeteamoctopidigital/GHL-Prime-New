import { z } from 'zod'
import { booleanish, optionalString } from '../../shared/validators/common.validators.js'

/** `tags` is a text[] column; accept an array or a comma-separated string. */
const tagsField = z
  .union([z.array(z.string()), z.string()])
  .optional()
  .transform((value): string[] | undefined => {
    if (value === undefined) return undefined
    if (Array.isArray(value)) return value.map((tag) => String(tag).trim()).filter(Boolean)

    return value
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean)
  })

const dateField = z
  .union([z.string(), z.date(), z.null()])
  .optional()
  .transform((value): Date | null | undefined => {
    if (value === undefined) return undefined
    if (value === null || value === '') return null

    const parsed = value instanceof Date ? value : new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  })

const numberField = z.coerce.number().int().nonnegative().optional().nullable()

const baseShape = {
  title: z.string().trim().min(1, 'Title is required').optional(),
  slug: optionalString,
  category: z.string().trim().min(1, 'Category is required').optional(),
  tags: tagsField,
  author: optionalString,
  excerpt: optionalString,
  content: optionalString,
  coverImage: optionalString,
  cover_image: optionalString,
  readingTime: numberField,
  reading_time: numberField,
  seoTitle: optionalString,
  seo_title: optionalString,
  seoDescription: optionalString,
  seo_description: optionalString,
  seoKeywords: optionalString,
  seo_keywords: optionalString,
  featured: booleanish.optional(),
  published: booleanish.optional(),
  publishedAt: dateField,
  published_at: dateField,
}

const base = z.object(baseShape)

/** Collapses snake_case aliases onto the Prisma field names. */
const normalize = (input: z.infer<typeof base>): Record<string, unknown> => {
  const {
    cover_image: coverImageSnake,
    reading_time: readingTimeSnake,
    seo_title: seoTitleSnake,
    seo_description: seoDescriptionSnake,
    seo_keywords: seoKeywordsSnake,
    published_at: publishedAtSnake,
    coverImage,
    readingTime,
    seoTitle,
    seoDescription,
    seoKeywords,
    publishedAt,
    ...rest
  } = input

  const merged: Record<string, unknown> = {
    ...rest,
    coverImage: coverImage ?? coverImageSnake,
    readingTime: readingTime ?? readingTimeSnake,
    seoTitle: seoTitle ?? seoTitleSnake,
    seoDescription: seoDescription ?? seoDescriptionSnake,
    seoKeywords: seoKeywords ?? seoKeywordsSnake,
    publishedAt: publishedAt ?? publishedAtSnake,
  }

  return Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined))
}

export const createBlogPostSchema = base
  .refine((data) => Boolean(data.title), { message: 'Title is required', path: ['title'] })
  .refine((data) => Boolean(data.category), { message: 'Category is required', path: ['category'] })
  .transform(normalize)

export const updateBlogPostSchema = base.transform(normalize)

export const blogListQuerySchema = z
  .object({
    category: z.string().trim().optional(),
    search: z.string().trim().optional(),
    featured: booleanish.optional(),
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().max(100).optional(),
  })
  .passthrough()

export const relatedQuerySchema = z
  .object({
    category: z.string().trim().min(1, 'category is required'),
    exclude: z.string().trim().optional(),
    limit: z.coerce.number().int().positive().max(20).default(3),
  })
  .passthrough()

export type BlogListQuery = z.infer<typeof blogListQuerySchema>
export type RelatedQuery = z.infer<typeof relatedQuerySchema>
