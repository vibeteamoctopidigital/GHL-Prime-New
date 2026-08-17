import type { NextFunction, Request, RequestHandler, Response } from 'express'

type AsyncRequestHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>

/**
 * Wraps an async route handler so a rejected promise reaches Express's error
 * middleware instead of hanging the request. Every controller is wrapped in
 * this — it is why no controller in this codebase needs a try/catch.
 */
export const asyncHandler =
  (handler: AsyncRequestHandler): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next)
  }

export default asyncHandler
