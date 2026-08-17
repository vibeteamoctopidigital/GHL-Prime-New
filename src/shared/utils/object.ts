/** Small object helpers used across services and serializers. */

/** Drops keys whose value is `undefined` — so a PATCH never nulls a field it omitted. */
export function pickDefined<T extends Record<string, unknown>>(source: T): Partial<T> {
  return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined)) as Partial<T>
}

/** Keeps only the listed keys (and only when defined). */
export function pick<T extends Record<string, unknown>, K extends keyof T>(source: T, keys: readonly K[]): Partial<Pick<T, K>> {
  const result: Partial<Pick<T, K>> = {}
  for (const key of keys) {
    if (source[key] !== undefined) result[key] = source[key]
  }
  return result
}

/** Returns a copy without the listed keys. */
export function omit<T extends Record<string, unknown>, K extends keyof T>(source: T, keys: readonly K[]): Omit<T, K> {
  const blocked = new Set<PropertyKey>(keys as readonly PropertyKey[])
  return Object.fromEntries(Object.entries(source).filter(([key]) => !blocked.has(key))) as Omit<T, K>
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `true` for "1", "true", "yes", "on" (any case) and boolean true. */
export function toBoolean(value: unknown, fallback?: boolean): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (value === undefined || value === null || value === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())
}

/** Coerces to a finite integer, or returns `fallback`. */
export function toInt(value: unknown, fallback?: number): number | undefined {
  const parsed = Number.parseInt(String(value), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

export default { pickDefined, pick, omit, isPlainObject, toBoolean, toInt }
