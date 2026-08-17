import { v2 as cloudinary } from 'cloudinary'
import env from './env.js'
import logger from '../shared/utils/logger.js'

/**
 * Cloudinary client.
 *
 * Configuration is optional at boot: until credentials are present the rest of
 * the API runs normally and only the upload routes report "not configured".
 * That keeps a missing key from taking the whole backend down.
 */

let configured = false

function configure(): void {
  if (configured || !env.hasCloudinary) return

  // CLOUDINARY_URL is read automatically by the SDK; the discrete vars win when
  // both are supplied, so an explicit override always beats a stale URL.
  if (env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET) {
    cloudinary.config({
      cloud_name: env.CLOUDINARY_CLOUD_NAME,
      api_key: env.CLOUDINARY_API_KEY,
      api_secret: env.CLOUDINARY_API_SECRET,
      secure: true,
    })
  } else {
    cloudinary.config({ secure: true })
  }

  configured = true
  logger.info(`Cloudinary configured (cloud: ${cloudinary.config().cloud_name ?? 'from CLOUDINARY_URL'})`)
}

/** Returns the configured SDK, or null when credentials are absent. */
export function getCloudinary(): typeof cloudinary | null {
  if (!env.hasCloudinary) return null
  configure()
  return cloudinary
}

export const isCloudinaryConfigured = (): boolean => env.hasCloudinary

/** Logged once at boot so a missing key is obvious in the startup output. */
export function reportCloudinaryStatus(): void {
  if (env.hasCloudinary) configure()
  else logger.warn('Cloudinary is not configured — image upload routes will return 503 until credentials are set')
}

export default getCloudinary
