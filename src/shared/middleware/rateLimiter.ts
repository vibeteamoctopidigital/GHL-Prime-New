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

export default apiLimiter
