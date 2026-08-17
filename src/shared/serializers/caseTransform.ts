import type { SerializedRow } from '../../types/common.js'

/**
 * Case conversion between the database/application layer (camelCase, which is
 * what Prisma produces) and the API wire format (snake_case, which is what the
 * existing frontend already reads: `image_url`, `sort_order`, `published_at`).
 *
 * Keeping the wire format snake_case means the React app's field access does
 * not change now that Supabase is gone.
 */

const camelToSnakeKey = (key: string): string => key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`)

const snakeToCamelKey = (key: string): string => key.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase())

function isTransformable(value: unknown): value is Record<string, unknown> | unknown[] {
  // Dates and other class instances must pass through untouched.
  return (
    value !== null &&
    typeof value === 'object' &&
    (Array.isArray(value) || (value as object).constructor === Object)
  )
}

function transformKeys(value: unknown, mapKey: (key: string) => string): unknown {
  if (Array.isArray(value)) return value.map((entry) => transformKeys(entry, mapKey))
  if (!isTransformable(value)) return value

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [mapKey(key), transformKeys(entry, mapKey)]),
  )
}

/** Deep camelCase -> snake_case. Used on the way out. */
export const toSnakeCase = <T = SerializedRow>(value: unknown): T => transformKeys(value, camelToSnakeKey) as T

/** Deep snake_case -> camelCase. Used on the way in. */
export const toCamelCase = <T = Record<string, unknown>>(value: unknown): T => transformKeys(value, snakeToCamelKey) as T

/**
 * Default serializer for API responses. Compose it when a resource needs extra
 * derived fields:
 *
 *   const serialize = (row) => ({ ...defaultSerializer(row), name: row.companyName })
 */
export const defaultSerializer = (row: unknown): SerializedRow => toSnakeCase<SerializedRow>(row)

export default { toSnakeCase, toCamelCase, defaultSerializer }
