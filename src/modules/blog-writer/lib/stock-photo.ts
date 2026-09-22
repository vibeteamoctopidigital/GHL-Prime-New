import env from '../../../config/env.js'
import uploadService from '../../uploads/upload.service.js'

/**
 * Pexels search plus Cloudinary upload, for the blog importer.
 *
 * Reuses the same upload service every other feature in this app already
 * uses, so a blog photo lands in the same folder and the same media_assets
 * table as a hand-uploaded one. Everything is best-effort and returns null on
 * failure: a post with one picture instead of three is a fine outcome, a post
 * that failed to import because a photo could not be found is not.
 */

export type StockPhoto = {
  /** The Cloudinary URL, after the photo has been rehosted. */
  url: string
  alt: string
  /** The attribution Pexels' licence requires us to print. */
  creditHtml: string
  /** The Pexels image URL, used to keep one post from repeating a photo. */
  sourceUrl: string
}

type PexelsApiPhoto = {
  alt?: string
  src?: { large2x?: string; large?: string }
  photographer?: string
  photographer_url?: string
  url?: string
}

/**
 * How wide a pool each query draws from. Sampling within the first page of
 * results keeps two related posts from sharing a picture.
 */
const PER_PAGE = 30

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Search Pexels and pick a photo this post has not already used. */
async function searchPexels(query: string, exclude: Set<string>): Promise<PexelsApiPhoto | null> {
  if (!env.PEXELS_API_KEY) return null

  let res: Response
  try {
    res = await fetch(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${PER_PAGE}&orientation=landscape`,
      { headers: { Authorization: env.PEXELS_API_KEY } },
    )
  } catch {
    return null
  }

  if (!res.ok) return null

  const payload = (await res.json().catch(() => null)) as { photos?: PexelsApiPhoto[] } | null
  const photos = payload?.photos ?? []

  // Shuffled rather than taken in order, so two posts on the same subject do
  // not both land on whatever Pexels ranks first today.
  const shuffled = [...photos].sort(() => Math.random() - 0.5)

  return (
    shuffled.find((photo) => {
      const src = photo.src?.large2x || photo.src?.large
      return Boolean(src) && !exclude.has(src as string)
    }) ?? null
  )
}

/**
 * Find a photo for `query` and rehost it on Cloudinary.
 *
 * Rehosted rather than hotlinked because a Pexels URL is outside our control,
 * and a published post should not depend on someone else's CDN for an image
 * it will show for years. Falls back to the Pexels URL itself when Cloudinary
 * is not configured.
 */
export async function fetchStockPhoto(opts: {
  query: string
  /** Used for the alt text and the Cloudinary filename. */
  keyword: string
  /** Photos already used by this post, so it never repeats one. */
  exclude: Set<string>
  role: 'cover' | 'body'
}): Promise<StockPhoto | null> {
  const photo = await searchPexels(opts.query, opts.exclude)
  if (!photo) return null

  const sourceUrl = photo.src?.large2x || photo.src?.large
  if (!sourceUrl) return null

  const alt = photo.alt?.trim() || opts.keyword

  let url = sourceUrl
  if (uploadService.isConfigured) {
    try {
      const res = await fetch(sourceUrl)
      if (!res.ok) return null
      const buffer = Buffer.from(await res.arrayBuffer())

      const slug = opts.keyword
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60)

      const uploaded = await uploadService.uploadImage(
        { buffer, originalName: `${slug}-${opts.role}.jpg`, mimeType: 'image/jpeg' },
        { folder: `${env.CLOUDINARY_UPLOAD_FOLDER}/blog`, alt, tags: ['blog-writer'] },
      )
      const secure = (uploaded as { secure_url?: string; url?: string }).secure_url || (uploaded as { url?: string }).url
      if (secure) url = secure
    } catch {
      // The raw Pexels URL still works as an image; it just isn't mirrored
      // onto our own CDN. Decoration is never worth losing the writing over.
    }
  }

  // Required by the Pexels licence: the photographer and the platform, both
  // linked. Not optional, and not something to trim for tidiness.
  const creditHtml = `<p><em>${opts.role === 'cover' ? 'Cover photo' : 'Photo'} by <a href="${escapeHtml(
    photo.photographer_url ?? '',
  )}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(
    photo.photographer ?? 'Pexels',
  )}</a> on <a href="${escapeHtml(photo.url ?? 'https://www.pexels.com')}" target="_blank" rel="noopener noreferrer nofollow">Pexels</a></em></p>`

  return { url, alt, creditHtml, sourceUrl }
}

export function isPexelsConfigured(): boolean {
  return Boolean(env.PEXELS_API_KEY)
}
