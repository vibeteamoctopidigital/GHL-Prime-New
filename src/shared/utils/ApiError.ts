import { HTTP_STATUS } from '../../config/constants.js'

export interface ApiErrorOptions {
  details?: unknown
  code?: string | null
  cause?: unknown
}

/**
 * Operational error carrying an HTTP status. Anything thrown that is NOT an
 * ApiError is treated by the error handler as an unexpected bug (500, details
 * hidden in production).
 */
export class ApiError extends Error {
  public readonly statusCode: number
  public readonly details: unknown
  public readonly code: string | null
  public readonly isOperational = true

  constructor(statusCode: number, message: string, options: ApiErrorOptions = {}) {
    super(message)
    this.name = 'ApiError'
    this.statusCode = statusCode
    this.details = options.details ?? null
    this.code = options.code ?? null
    if (options.cause !== undefined) this.cause = options.cause
    Error.captureStackTrace?.(this, this.constructor)
  }

  static badRequest(message = 'Bad request', options?: ApiErrorOptions): ApiError {
    return new ApiError(HTTP_STATUS.BAD_REQUEST, message, options)
  }

  static unauthorized(message = 'Authentication required', options?: ApiErrorOptions): ApiError {
    return new ApiError(HTTP_STATUS.UNAUTHORIZED, message, options)
  }

  static forbidden(message = 'You do not have permission to perform this action', options?: ApiErrorOptions): ApiError {
    return new ApiError(HTTP_STATUS.FORBIDDEN, message, options)
  }

  static notFound(message = 'Resource not found', options?: ApiErrorOptions): ApiError {
    return new ApiError(HTTP_STATUS.NOT_FOUND, message, options)
  }

  static conflict(message = 'Resource already exists', options?: ApiErrorOptions): ApiError {
    return new ApiError(HTTP_STATUS.CONFLICT, message, options)
  }

  static unprocessable(message = 'Validation failed', options?: ApiErrorOptions): ApiError {
    return new ApiError(HTTP_STATUS.UNPROCESSABLE_ENTITY, message, options)
  }

  static tooManyRequests(message = 'Too many requests', options?: ApiErrorOptions): ApiError {
    return new ApiError(HTTP_STATUS.TOO_MANY_REQUESTS, message, options)
  }

  static internal(message = 'Internal server error', options?: ApiErrorOptions): ApiError {
    return new ApiError(HTTP_STATUS.INTERNAL_SERVER_ERROR, message, options)
  }

  /** A route that deliberately isn't built — distinct from notFound, which means the URL itself is wrong. */
  static notImplemented(message = 'Not implemented', options?: ApiErrorOptions): ApiError {
    return new ApiError(HTTP_STATUS.NOT_IMPLEMENTED, message, options)
  }

  static badGateway(message = 'Upstream request failed', options?: ApiErrorOptions): ApiError {
    return new ApiError(HTTP_STATUS.BAD_GATEWAY, message, options)
  }

  /** A dependency this endpoint needs is not configured or is offline. */
  static serviceUnavailable(message = 'Service temporarily unavailable', options?: ApiErrorOptions): ApiError {
    return new ApiError(HTTP_STATUS.SERVICE_UNAVAILABLE, message, options)
  }
}

export default ApiError
