/**
 * Shared presentational pieces.
 *
 * Small and boring on purpose. The two rules they encode are:
 *
 *  1. A LOADING OR FAILED STATE IS ALWAYS SHOWN. Never a blank panel, which
 *     leaves the user unable to tell "nothing here" from "still coming" from
 *     "it broke".
 *
 *  2. COLOUR IS NEVER THE ONLY SIGNAL. Every status badge carries words as well
 *     as a colour, because a colour-blind user, a printed page and a screen
 *     reader all need the text.
 */
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { ApiError } from '../lib/api'
import type { BookingStatus, FacilityStatus } from '../lib/types'

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

const BOOKING_STYLES: Record<BookingStatus, { className: string; label: string }> = {
  confirmed: { className: 'bg-emerald-100 text-emerald-800', label: 'Confirmed' },
  cancelled: { className: 'bg-campus-200 text-campus-700', label: 'Cancelled' },
  completed: { className: 'bg-brand-100 text-brand-800', label: 'Completed' },
}

export function BookingStatusBadge({ status }: { status: BookingStatus }): JSX.Element {
  const style = BOOKING_STYLES[status]

  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${style.className}`}>
      {style.label}
    </span>
  )
}

const FACILITY_STYLES: Record<FacilityStatus, { className: string; label: string }> = {
  active: { className: 'bg-emerald-100 text-emerald-800', label: 'Available' },
  inactive: { className: 'bg-rose-100 text-rose-800', label: 'Withdrawn' },
  maintenance: { className: 'bg-accent-100 text-accent-700', label: 'Maintenance' },
}

export function FacilityStatusBadge({ status }: { status: FacilityStatus }): JSX.Element {
  const style = FACILITY_STYLES[status]

  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${style.className}`}>
      {style.label}
    </span>
  )
}

/** A small neutral chip, for equipment, accessibility notes and activities. */
export function Tag({ children }: { children: ReactNode }): JSX.Element {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-campus-100 text-campus-700 text-xs">
      {children}
    </span>
  )
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

export function Loading({ label = 'Loading…' }: { label?: string }): JSX.Element {
  return (
    <div className="flex items-center gap-3 text-campus-600 py-10" role="status" aria-live="polite">
      <span
        className="h-4 w-4 rounded-full border-2 border-campus-300 border-t-brand-600 animate-spin"
        aria-hidden="true"
      />
      <span>{label}</span>
    </div>
  )
}

export function ErrorBanner({
  error,
  onRetry,
  title = 'That did not work',
}: {
  error: ApiError
  onRetry?: () => void
  title?: string
}): JSX.Element {
  return (
    <div
      role="alert"
      className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-rose-900"
    >
      <p className="font-semibold">{title}</p>
      <p className="mt-1 text-sm">{error.message}</p>

      {onRetry ? (
        <button type="button" onClick={onRetry} className="mt-3 text-sm font-medium underline">
          Try again
        </button>
      ) : null}
    </div>
  )
}

/**
 * A neutral explanation.
 *
 * Used for things that are true but not failures - a facility closed on a
 * Sunday, a filter that matched nothing. Rendering these as errors would train
 * the user to ignore error colours.
 */
export function Notice({
  children,
  tone = 'neutral',
}: {
  children: ReactNode
  tone?: 'neutral' | 'info'
}): JSX.Element {
  const className =
    tone === 'info'
      ? 'border-brand-200 bg-brand-50 text-brand-900'
      : 'border-campus-200 bg-white text-campus-700'

  return <div className={`rounded-xl border p-4 text-sm ${className}`}>{children}</div>
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string
  description: string
  /**
   * A call to action. `onClick` is used where the remedy is a piece of page
   * state - clearing filters, for instance - and a link would be misleading
   * because the state would survive the navigation.
   */
  action?: { label: string; to?: string; onClick?: () => void }
}): JSX.Element {
  const className = 'inline-block mt-5 px-4 py-2 rounded-lg bg-brand-600 text-white text-sm font-medium hover:bg-brand-700'

  return (
    <div className="surface p-10 text-center">
      <h3 className="text-lg mb-2">{title}</h3>
      <p className="text-campus-600 max-w-prose mx-auto">{description}</p>

      {action?.to ? (
        <Link to={action.to} className={className}>
          {action.label}
        </Link>
      ) : null}

      {action?.onClick ? (
        <button type="button" onClick={action.onClick} className={className}>
          {action.label}
        </button>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Form furniture
// ---------------------------------------------------------------------------

export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
  required,
}: {
  label: string
  htmlFor: string
  hint?: string
  error?: string | undefined
  children: ReactNode
  required?: boolean
}): JSX.Element {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-sm font-medium text-campus-800">
        {label}
        {required ? <span className="text-rose-700"> *</span> : null}
      </label>

      {hint ? (
        <p id={`${htmlFor}-hint`} className="text-xs text-campus-500 mt-0.5">
          {hint}
        </p>
      ) : null}

      <div className="mt-1.5">{children}</div>

      {error ? (
        <p id={`${htmlFor}-error`} className="text-sm text-rose-700 mt-1">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export const inputClass =
  'w-full rounded-lg border border-campus-300 bg-white px-3 py-2 text-campus-900 ' +
  'placeholder:text-campus-400 focus:border-brand-500'

export const buttonPrimary =
  'inline-flex items-center justify-center gap-2 rounded-lg bg-brand-600 px-4 py-2 ' +
  'text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50 ' +
  'disabled:cursor-not-allowed'

export const buttonSecondary =
  'inline-flex items-center justify-center gap-2 rounded-lg border border-campus-300 ' +
  'bg-white px-4 py-2 text-sm font-medium text-campus-800 hover:bg-campus-50 ' +
  'disabled:opacity-50 disabled:cursor-not-allowed'
