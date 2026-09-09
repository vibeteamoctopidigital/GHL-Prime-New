import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit'
import env from '../../config/env.js'
import { HTTP_STATUS } from '../../config/constants.js'

interface LimiterOptions {
  max: number
  windowMs?: number
  message: string
}

function build({ max, windowMs = env.RATE_LIMIT_WINDOW_MS, message }: LimiterOptions): RateLimitRequestHandler {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    // Skip entirely in tests so suites are not throttled by each other.
    skip: () => env.isTest,
    handler: (_req, res) => {
      res.status(HTTP_STATUS.TOO_MANY_REQUESTS).json({ success: false, message })
    },
  })
}

/** Baseline limiter applied to the whole API. */
export const apiLimiter = build({
  max: env.RATE_LIMIT_MAX,
  message: 'Too many requests. Please try again later.',
})

/** Tight limiter for credential endpoints — slows down brute-force attempts. */
export const authLimiter = build({
  max: env.AUTH_RATE_LIMIT_MAX,
  message: 'Too many authentication attempts. Please try again later.',
})

/** Public form submissions: generous enough for humans, not for scripts. */
export const submissionLimiter = build({
  max: 20,
  windowMs: 60 * 60 * 1000,
  message: 'Too many submissions. Please try again later.',
})

/**
 * The Auto Blog cron trigger (POST /blog-ai/cron/trigger) is secret-protected
 * but still a public, unauthenticated-by-session URL — defense in depth
 * against the secret being guessed/leaked, on top of the secret check itself.
 * An external scheduler pinging every 5-15 minutes needs nowhere near this
 * many requests/hour.
 */
export const cronTriggerLimiter = build({
  max: 30,
  windowMs: 60 * 60 * 1000,
  message: 'Too many requests to the cron trigger endpoint.',
})

export default apiLimiter
