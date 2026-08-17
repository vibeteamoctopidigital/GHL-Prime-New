import slugifyLib from 'slugify'

const OPTIONS = { lower: true, strict: true, trim: true } as const

export function toSlug(value: unknown): string {
  return slugifyLib(String(value ?? ''), OPTIONS)
}

/**
 * Builds a slug that does not collide with an existing row.
 *
 * @param source   Text to slugify (falls back to `fallback`).
 * @param exists   Returns true if the candidate slug is taken.
 * @param fallback Used when `source` slugifies to an empty string.
 */
export async function buildUniqueSlug(
  source: unknown,
  exists: (slug: string) => Promise<boolean>,
  fallback = 'item',
): Promise<string> {
  const base = toSlug(source) || fallback
  let candidate = base
  let suffix = 2

  // Bounded so a misbehaving `exists` cannot spin forever.
  while (suffix < 1000 && (await exists(candidate))) {
    candidate = `${base}-${suffix}`
    suffix += 1
  }

  return candidate
}

export default { toSlug, buildUniqueSlug }
