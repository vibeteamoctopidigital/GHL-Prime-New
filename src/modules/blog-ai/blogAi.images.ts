import { randomUUID } from 'node:crypto'
import OpenAI from 'openai'
import supabase from '../../config/supabase.js'
import logger from '../../shared/utils/logger.js'

/**
 * AI cover images generator using openai's image-generation endpoint. Returns a public URL to the generated image, or null if generation failed.
 */

const IMAGE_TIMEOUT_MS = 60 * 1000
const DEFAULT_IMAGE_MODEL = 'gpt-image-2'
const BUCKET = 'blog-covers'

export interface CoverImage {
  url: string
  alt: string
}

function buildImagePrompt(title: string, excerpt: string): string {
  return [
    `Create a click-worthy, attention-grabbing, professional BLOG CARD THUMBNAIL for an article titled "${title}".`,
    excerpt ? `Article summary: ${excerpt}` : '',
    'This is a small blog-listing card image, NOT a full-page hero banner — keep the composition simple and legible at small',
    'sizes, with a single clear focal point. Style: clean, modern, flat/minimal tech-SaaS editorial illustration.',
    'No embedded text, no logos, no watermarks. The image should accurately represent the article, not be misleading clickbait.',
  ]
    .filter(Boolean)
    .join(' ')
}

export async function generateCoverImage(opts: {
  apiKey: string
  model?: string | undefined
  title: string
  excerpt: string
}): Promise<CoverImage | null> {
  if (!supabase) {
    logger.warn('Blog AI: Supabase Storage is not configured (SUPABASE_URL/SUPABASE_SECRET_KEY) — skipping cover image, using the placeholder instead.')
    return null
  }

  try {
    const client = new OpenAI({ apiKey: opts.apiKey, timeout: IMAGE_TIMEOUT_MS })

    const result = await client.images.generate({
      model: opts.model || DEFAULT_IMAGE_MODEL,
      prompt: buildImagePrompt(opts.title, opts.excerpt),
      // Blog-card aspect ratio (3:2, same shape as a 600x400 thumbnail) at a
      // resolution comfortably above the API's minimum pixel count — a card
      // image, not a full-page hero banner.
      size: '1200x800',
    })

    const base64 = result.data?.[0]?.b64_json
    if (!base64) throw new Error('OpenAI image generation returned no image data')

    const buffer = Buffer.from(base64, 'base64')
    const path = `${new Date().getUTCFullYear()}/${randomUUID()}.png`

    const { error: uploadError } = await supabase.storage.from(BUCKET).upload(path, buffer, {
      contentType: 'image/png',
      upsert: false,
    })
    if (uploadError) throw new Error(`Could not upload cover image to storage: ${uploadError.message}`)

    const { data: publicUrlData } = supabase.storage.from(BUCKET).getPublicUrl(path)

    return { url: publicUrlData.publicUrl, alt: `Cover image for: ${opts.title}` }
  } catch (error) {
    logger.warn('Blog AI: cover image generation failed, proceeding without one:', error instanceof Error ? error.message : error)
    return null
  }
}

export default generateCoverImage
