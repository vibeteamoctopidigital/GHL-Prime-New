import type { ErrorRequestHandler, RequestHandler } from 'express'
import { ZodError } from 'zod'
import env from '../../config/env.js'
import { HTTP_STATUS } from '../../config/constants.js'
import ApiError from '../utils/ApiError.js'
import logger from '../utils/logger.js'
import { sendError } from '../utils/ApiResponse.js'

function normalize(error: unknown): ApiError | null {
  if (error instanceof ApiError) return error

  if (error instanceof ZodError) {
    return ApiError.unprocessable('Validation failed', {
      details: error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
    })
  }

  // Body-parser rejects malformed JSON with a SyntaxError carrying a status.
  if (error instanceof SyntaxError && (error as SyntaxError & { status?: number }).status === 400 && 'body' in error) {
    return ApiError.badRequest('Malformed JSON in request body')
  }

  return null
}

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  const normalized = normalize(error)

  if (normalized) {
    if (normalized.statusCode >= HTTP_STATUS.INTERNAL_SERVER_ERROR) {
      logger.error(`${req.method} ${req.originalUrl} ->`, normalized.message, (error as Error)?.stack)
    } else {
      logger.warn(`${req.method} ${req.originalUrl} -> ${normalized.statusCode} ${normalized.message}`)
    }

    sendError(res, {
      message: normalized.message,
      statusCode: normalized.statusCode,
      errors: normalized.details,
    })
    return
  }

  // Unexpected: log everything, tell the client nothing revealing.
  logger.error(`${req.method} ${req.originalUrl} -> unhandled error`, error)

  const message = error instanceof Error ? error.message : 'Internal server error'

  sendError(res, {
    message: env.isProduction ? 'Internal server error' : message,
    statusCode: HTTP_STATUS.INTERNAL_SERVER_ERROR,
    errors: env.isProduction ? null : { stack: (error as Error)?.stack },
  })
}

interface RouterLayer {
  route?: { path: string; methods: Record<string, boolean> }
  name?: string
  handle?: { stack?: RouterLayer[] }
  regexp?: RegExp & { fast_slash?: boolean }
}

/**
 * Which HTTP methods the given path accepts, if any.
 *
 * Express answers 404 when a path exists but not for the method used — so
 * opening a POST-only endpoint like /api/auth/login in a browser reads as
 * "this route is missing" when it is really "wrong verb". This walks the
 * router so the response can say which verbs the path does accept.
 */
function methodsFor(req: Parameters<RequestHandler>[0], target: string): string[] {
  const found = new Set<string>()

  const walk = (stack: RouterLayer[] | undefined, prefix: string): void => {
    for (const layer of stack ?? []) {
      if (layer.route) {
        const full = `${prefix}${layer.route.path}`.replace(/\/{2,}/g, '/')
        const pattern = new RegExp(`^${full.replace(/:[^/]+/g, '[^/]+').replace(/\*/g, '.*')}/?$`)

        if (pattern.test(target)) {
          for (const [method, enabled] of Object.entries(layer.route.methods)) {
            if (enabled && method !== '_all') found.add(method.toUpperCase())
          }
        }
        continue
      }

      if (layer.name === 'router' && layer.handle?.stack) {
        const source = layer.regexp?.source ?? ''
        const match = /^\^\\\/(?<path>.*?)\\\/\?\(\?=\\\/\|\$\)$/.exec(source)
        const mount = match?.groups?.['path'] ? `/${match.groups['path'].replace(/\\\//g, '/')}` : ''
        walk(layer.handle.stack, `${prefix}${mount}`)
      }
    }
  }

  const root = (req.app as unknown as { _router?: { stack: RouterLayer[] } })._router
  walk(root?.stack, '')

  return [...found]
}

/** Terminal 404 for unmatched routes — keeps the error envelope consistent. */
export const notFound: RequestHandler = (req, _res, next) => {
  const allowed = methodsFor(req, req.path).filter((method) => method !== req.method)

  if (allowed.length > 0) {
    next(
      new ApiError(
        HTTP_STATUS.METHOD_NOT_ALLOWED,
        `${req.method} is not allowed on ${req.path}. Use ${allowed.sort().join(' or ')}.`,
        { details: { allowed_methods: allowed.sort() } },
      ),
    )
    return
  }

  next(ApiError.notFound(`Route not found: ${req.method} ${req.originalUrl}`))
}

export default errorHandler
