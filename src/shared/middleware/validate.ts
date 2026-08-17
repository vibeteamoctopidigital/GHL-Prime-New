import type { RequestHandler } from 'express'
import { ZodError, type ZodTypeAny } from 'zod'
import ApiError from '../utils/ApiError.js'
import type { ValidationIssue } from '../../types/common.js'

export interface ValidationSchemas {
  body?: ZodTypeAny
  query?: ZodTypeAny
  params?: ZodTypeAny
}

function formatIssues(error: ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || '(root)',
    message: issue.message,
  }))
}

/**
 * Validates request parts against Zod schemas and REPLACES them with the parsed
 * result, so controllers always receive coerced, trimmed, known-shape data.
 *
 *   router.post('/', validate({ body: createSchema }), controller.create)
 */
export function validate(schemas: ValidationSchemas = {}): RequestHandler {
  return (req, _res, next) => {
    try {
      if (schemas.params) {
        req.params = schemas.params.parse(req.params) as typeof req.params
      }

      if (schemas.query) {
        const parsed = schemas.query.parse(req.query) as Record<string, unknown>
        // Express 5 exposes req.query as a getter, so assign properties in place.
        for (const key of Object.keys(req.query)) delete (req.query as Record<string, unknown>)[key]
        Object.assign(req.query, parsed)
      }

      if (schemas.body) {
        req.body = schemas.body.parse(req.body)
      }

      return next()
    } catch (error) {
      if (error instanceof ZodError) {
        return next(ApiError.unprocessable('Validation failed', { details: formatIssues(error) }))
      }
      return next(error)
    }
  }
}

export default validate
