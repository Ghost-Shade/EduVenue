/**
 * Typed API errors.
 *
 * Every failure the API returns to a client goes through `ApiError`, so:
 *
 *   - the HTTP status is chosen once, deliberately, next to the reason;
 *   - a machine-readable `code` lets the client branch on the failure without
 *     string-matching a human message;
 *   - `details` carries structured context (for example the conflicting
 *     booking, or suggested alternative slots) that the UI turns into a useful
 *     message instead of a bare rejection.
 *
 * Unexpected errors are NOT wrapped - they surface as a 500 with no detail
 * leaked to the client. See middleware/errorHandler.ts.
 */

export type ApiErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'FACILITY_UNAVAILABLE'
  | 'OUTSIDE_OPERATING_HOURS'
  | 'CAPACITY_EXCEEDED'
  | 'ACTIVITY_NOT_PERMITTED'
  | 'SUPERVISION_REQUIRED'
  | 'CANCELLATION_NOT_PERMITTED'
  | 'INTERNAL_ERROR'

export interface ApiErrorDetail {
  field?: string
  message: string
}

export class ApiError extends Error {
  readonly status: number
  readonly code: ApiErrorCode
  readonly details: unknown

  constructor(status: number, code: ApiErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

// ---------------------------------------------------------------------------
// Constructors for the cases the application actually produces.
//
// Using these rather than `new ApiError(409, ...)` inline keeps the status and
// code pairing consistent, which matters when the client switches on `code`.
// ---------------------------------------------------------------------------

export function badRequest(message: string, details?: ApiErrorDetail[]): ApiError {
  return new ApiError(400, 'VALIDATION_FAILED', message, details)
}

export function unauthenticated(message = 'You must sign in to do that.'): ApiError {
  return new ApiError(401, 'UNAUTHENTICATED', message)
}

export function forbidden(message = 'You do not have permission to do that.'): ApiError {
  return new ApiError(403, 'FORBIDDEN', message)
}

export function notFound(message = 'Not found.'): ApiError {
  return new ApiError(404, 'NOT_FOUND', message)
}

export function notFoundFacility(): ApiError {
  return new ApiError(404, 'NOT_FOUND', 'That facility does not exist.')
}

/**
 * A booking was rejected because the requested slot is already taken.
 *
 * 409 rather than 400: the request was well formed, it is the current state of
 * the world that prevents it. The client can offer alternatives rather than
 * asking the user to fix their input.
 */
export function bookingConflict(message: string, details?: unknown): ApiError {
  return new ApiError(409, 'CONFLICT', message, details)
}

/** A rule other than plain overlap was violated. All map to 409. */
export function facilityUnavailable(message: string, details?: unknown): ApiError {
  return new ApiError(409, 'FACILITY_UNAVAILABLE', message, details)
}

export function outsideOperatingHours(message: string, details?: unknown): ApiError {
  return new ApiError(409, 'OUTSIDE_OPERATING_HOURS', message, details)
}

export function capacityExceeded(message: string, details?: unknown): ApiError {
  return new ApiError(409, 'CAPACITY_EXCEEDED', message, details)
}

export function activityNotPermitted(message: string, details?: unknown): ApiError {
  return new ApiError(409, 'ACTIVITY_NOT_PERMITTED', message, details)
}

export function supervisionRequired(message: string, details?: unknown): ApiError {
  return new ApiError(409, 'SUPERVISION_REQUIRED', message, details)
}

/**
 * Compatibility check used to decide whether an error is safe to return to the
 * client as-is.
 */
export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError
}
