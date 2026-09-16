/**
 * Sources a cover image for a topic and uploads it to Cloudinary — reusing
 * the same image pipeline every other feature in this app already uses
 * (src/config/cloudinary.ts), not a second, separate storage bucket.
 *
 *   npx tsx scripts/blog-import.ts "<search query>"
 *
 * Prints { cover_image: string | null } as JSON. Without either
 * PEXELS_API_KEY or UNSPLASH_ACCESS_KEY configured, or if the search finds
 * nothing, prints { cover_image: null } and exits 0 — a missing cover image
 * is never a reason to fail the whole run.
 */
import env from '../src/config/env.js'
import { getCloudinary } from '../src/config/cloudinary.js'
import logger from '../src/shared/utils/logger.js'

async function findPexelsPhoto(query: string): Promise<string | null> {
  if (!env.PEXELS_API_KEY) return null

  const res = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1&orientation=landscape`, {
    headers: { Authorization: env.PEXELS_API_KEY },
  })
  if (!res.ok) {
    logger.warn(`blog-import: Pexels search failed (${res.status})`)
    return null
  }

  const data = (await res.json()) as { photos?: Array<{ src?: { large2x?: string; large?: string } }> }
  return data.photos?.[0]?.src?.large2x ?? data.photos?.[0]?.src?.large ?? null
}

async function findUnsplashPhoto(query: string): Promise<string | null> {
  if (!env.UNSPLASH_ACCESS_KEY) return null

  const res = await fetch(`https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=1&orientation=landscape`, {
    headers: { Authorization: `Client-ID ${env.UNSPLASH_ACCESS_KEY}` },
  })
  if (!res.ok) {
    logger.warn(`blog-import: Unsplash search failed (${res.status})`)
    return null
  }

  const data = (await res.json()) as { results?: Array<{ urls?: { regular?: string } }> }
  return data.results?.[0]?.urls?.regular ?? null
}

async function main(): Promise<void> {
  const query = process.argv[2]
  if (!query) throw new Error('Usage: blog-import.ts "<search query>"')

  const sourceUrl = (await findPexelsPhoto(query)) ?? (await findUnsplashPhoto(query))
  if (!sourceUrl) {
    console.log(JSON.stringify({ cover_image: null }))
    return
  }

  const cloudinary = getCloudinary()
  if (!cloudinary) {
    // Cloudinary not configured — the raw stock-photo URL still works as a
    // cover image, it just isn't mirrored onto our own CDN.
    console.log(JSON.stringify({ cover_image: sourceUrl }))
    return
  }

  try {
    const uploaded = await cloudinary.uploader.upload(sourceUrl, {
      folder: `${env.CLOUDINARY_UPLOAD_FOLDER}/blog`,
      ...(env.CLOUDINARY_UPLOAD_PRESET ? { upload_preset: env.CLOUDINARY_UPLOAD_PRESET } : {}),
    })
    console.log(JSON.stringify({ cover_image: uploaded.secure_url }))
  } catch (error) {
    logger.warn('blog-import: Cloudinary upload failed, falling back to the stock-photo URL directly:', error)
    console.log(JSON.stringify({ cover_image: sourceUrl }))
  }
}

main().catch((error) => {
  console.error('blog-import failed:', error instanceof Error ? error.message : error)
  // Exit 0 even on a genuine crash: per the spec, a missing image is never a
  // reason to fail the run — the caller just gets no cover_image field.
  console.log(JSON.stringify({ cover_image: null }))
})
