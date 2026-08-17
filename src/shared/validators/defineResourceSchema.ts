import { z, type ZodTypeAny } from 'zod'
import { booleanish, sortOrderSchema } from './common.validators.js'

const camelToSnake = (key: string): string => key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`)

export interface ResourceSchemaOptions {
  /** camelCase field name -> Zod schema. */
  fields: Record<string, ZodTypeAny>
  /** Fields the CREATE schema must receive (either casing satisfies it). */
  required?: readonly string[]
  /** Add `sortOrder` + `published` automatically. Default true. */
  sortable?: boolean
}

export interface ResourceSchemas {
  createSchema: ZodTypeAny
  updateSchema: ZodTypeAny
}

/**
 * Builds a create/update schema pair from a camelCase field map, and accepts
 * BOTH `imageUrl` and `image_url` on input while always emitting the camelCase
 * name Prisma expects.
 *
 *   const { createSchema, updateSchema } = defineResourceSchema({
 *     fields: { name: requiredString('Name'), imageUrl: optionalUrl },
 *     required: ['name', 'imageUrl'],
 *   })
 */
export function defineResourceSchema({ fields, required = [], sortable = true }: ResourceSchemaOptions): ResourceSchemas {
  const allFields: Record<string, ZodTypeAny> = {
    ...fields,
    ...(sortable ? { sortOrder: sortOrderSchema, published: booleanish.optional() } : {}),
  }

  const fieldNames = Object.keys(allFields)

  // Every field is optional at parse time; `required` is enforced afterwards so
  // the snake_case alias can satisfy it too.
  const shape: Record<string, ZodTypeAny> = {}

  for (const [key, schema] of Object.entries(allFields)) {
    const optionalSchema = schema.isOptional() ? schema : schema.optional()
    shape[key] = optionalSchema

    const snakeKey = camelToSnake(key)
    if (snakeKey !== key) shape[snakeKey] = optionalSchema
  }

  const base = z.object(shape)

  const normalize = (input: Record<string, unknown>): Record<string, unknown> => {
    const output: Record<string, unknown> = {}

    for (const key of fieldNames) {
      const value = input[key] ?? input[camelToSnake(key)]
      if (value !== undefined) output[key] = value
    }

    return output
  }

  const createSchema = base
    .superRefine((input, ctx) => {
      for (const key of required) {
        const value = (input as Record<string, unknown>)[key] ?? (input as Record<string, unknown>)[camelToSnake(key)]

        if (value === undefined || value === null || value === '') {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} is required` })
        }
      }
    })
    .transform(normalize)

  const updateSchema = base.transform(normalize)

  return { createSchema, updateSchema }
}

export default defineResourceSchema
