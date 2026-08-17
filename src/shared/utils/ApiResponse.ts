import type { Response } from 'express'
import { HTTP_STATUS } from '../../config/constants.js'
import type { ApiErrorBody, ApiSuccessBody, PaginationMeta } from '../../types/common.js'

/**
 * One response envelope for the whole API so clients never have to guess:
 *   { success: true, message, data, meta? }
 *   { success: false, message, errors? }
 */

interface SuccessOptions<T> {
  data?: T
  message?: string
  statusCode?: number
  meta?: PaginationMeta | null
}

export function sendSuccess<T>(res: Response, options: SuccessOptions<T> = {}): Response {
  const { data = null as T, message = 'OK', statusCode = HTTP_STATUS.OK, meta = null } = options

  const body: ApiSuccessBody<T> = { success: true, message, data }
  if (meta) body.meta = meta

  return res.status(statusCode).json(body)
}

export const sendCreated = <T>(res: Response, options: Omit<SuccessOptions<T>, 'statusCode'>): Response =>
  sendSuccess(res, { message: 'Created successfully', ...options, statusCode: HTTP_STATUS.CREATED })

export const sendOk = <T>(res: Response, data: T, message = 'OK', meta?: PaginationMeta | null): Response =>
  sendSuccess(res, { data, message, meta: meta ?? null })

interface ErrorOptions {
  message?: string
  statusCode?: number
  errors?: unknown
}

export function sendError(res: Response, options: ErrorOptions = {}): Response {
  const { message = 'Something went wrong', statusCode = HTTP_STATUS.INTERNAL_SERVER_ERROR, errors = null } = options

  const body: ApiErrorBody = { success: false, message }
  if (errors) body.errors = errors

  return res.status(statusCode).json(body)
}

export default { sendSuccess, sendCreated, sendOk, sendError }
