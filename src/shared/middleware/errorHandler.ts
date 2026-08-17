import type { ErrorRequestHandler, RequestHandler } from 'express'
import { Prisma } from '@prisma/client'
import { ZodError } from 'zod'
import env from '../../config/env.js'
import { HTTP_STATUS } from '../../config/constants.js'
import ApiError from '../utils/ApiError.js'
import logger from '../utils/logger.js'
import { sendError } from '../utils/ApiResponse.js'

/** Turns Prisma's error codes into meaningful HTTP responses. */
function mapPrismaError(error: unknown): ApiError | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const rawTarget = error.meta?.['target']
    const target = Array.isArray(rawTarget) ? rawTarget.join(', ') : (rawTarget as string | undefined)

    switch (error.code) {
      case 'P2002':
        return ApiError.conflict(target ? `A record with this ${target} already exists` : 'Record already exists')
      case 'P2003':
        return ApiError.badRequest('Related record does not exist')
      case 'P2014':
        return ApiError.badRequest('This change would break a required relation')
      case 'P2025':
        return ApiError.notFound((error.meta?.['cause'] as string | undefined) ?? 'Record not found')
      default:
        return ApiError.badRequest('Database request failed', { code: error.code })
    }
  }

  if (error instanceof Prisma.PrismaClientValidationError) {
    return ApiError.badRequest('Invalid data supplied to the database query')
  }

  if (error instanceof Prisma.PrismaClientInitializationError) {
    return ApiError.internal('Could not connect to the database')
  }

  return null
}

function normalize(error: unknown): ApiError | null {
  if (error instanceof ApiError) return error

  if (error instanceof ZodError) {
    return ApiError.unprocessable('Validation failed', {
      details: error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
    })
  }

  const prismaError = mapPrismaError(error)
  if (prismaError) return prismaError

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

/** Terminal 404 for unmatched routes — keeps the error envelope consistent. */
export const notFound: RequestHandler = (req, _res, next) => {
  next(ApiError.notFound(`Route not found: ${req.method} ${req.originalUrl}`))
}

export default errorHandler
