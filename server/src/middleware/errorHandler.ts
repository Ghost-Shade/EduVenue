/**
 * Error handling.
 *
 * Two rules:
 *
 *  1. KNOWN FAILURES ARE DESCRIBED. An `ApiError` was raised deliberately by
 *     application code and carries a status, a machine-readable code, and a
 *     message written for a person. It is returned as-is.
 *
 *  2. UNKNOWN FAILURES ARE NOT. Anything else is a bug. The client receives a
 *     generic 500 with no stack trace, no SQL and no file paths, because those
 *     describe the internals of the system to whoever asked. The detail is
 *     logged on the server, where it belongs.
 *
 * Without rule 2, a malformed request that triggers a database error turns the
 * API into an oracle for its own schema.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express'

import { ApiError, isApiError } from '../lib/errors.ts'

export interface ApiErrorBody {
  error: {
    code: string
    message: string
    details?: unknown
  }
}

/**
 * Wraps an async route handler so that a rejected promise reaches the error
 * middleware.
 *
 * Express 4 does not do this automatically: an async handler that throws
 * produces an unhandled rejection and the request hangs until it times out,
 * with no error shown to the user. Wrapping every async handler is the fix.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void handler(req, res, next).catch(next)
  }
}

/**
 * Terminal handler for unmatched `/api` routes.
 *
 * Produces a 404 in the same JSON shape as every other error, so the client has
 * one error format to handle rather than two.
 */
export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new ApiError(404, 'NOT_FOUND', `No API route matches ${req.method} ${req.path}.`))
}

/** The single error handler. Must be registered last. */
export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  // If the response has already started, Express cannot send a new one.
  // Delegating lets Express close the connection cleanly.
  if (res.headersSent) {
    next(error)
    return
  }

  if (isApiError(error)) {
    res.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    } satisfies ApiErrorBody)
    return
  }

  // Anything reaching here is unexpected. Log the full detail server-side and
  // tell the client nothing.
  console.error('[api] unhandled error:', error)

  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message:
        'Something went wrong on the server. The problem has been logged. ' +
        'If it continues, check the server console.',
    },
  } satisfies ApiErrorBody)
}
