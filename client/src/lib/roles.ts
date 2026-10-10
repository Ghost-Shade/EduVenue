/**
 * Role names and ranking, mirroring `server/src/lib/roles.ts`.
 *
 * Used ONLY to decide what to show. Every rule expressed with these helpers is
 * enforced again on the server, which is what actually prevents anything.
 */
import type { SessionUser, UserRole } from './types'

export const ROLE_RANK: Record<UserRole, number> = {
  student: 0,
  rep: 1,
  supervisor: 2,
  admin: 3,
}

export const MIN_ROLE_LABELS: Record<UserRole, string> = {
  student: 'any signed-in user',
  rep: 'class representatives',
  supervisor: 'supervisors',
  admin: 'facility administrators',
}

export const POLICY_LABELS: Record<string, string> = {
  open: 'Open to eligible bookers',
  restricted: 'Restricted facility',
  supervisor_required: 'Supervision required',
}

export function roleAtLeast(role: UserRole, minimum: UserRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum]
}

/**
 * Whether this user could book this facility, in principle.
 *
 * Says nothing about whether a particular slot is free - that is the server's
 * answer to give, and the only one that counts. This exists so the interface
 * does not offer a booking form that is certain to be refused.
 */
export function mayBook(
  user: SessionUser | null,
  facility: { status: string; minRole: UserRole; bookingPolicy: string },
): boolean {
  if (!user) return false
  if (facility.status !== 'active') return false
  if (user.role === 'admin') return true
  if (!roleAtLeast(user.role, facility.minRole)) return false
  if (facility.bookingPolicy === 'supervisor_required' && user.role !== 'supervisor') return false

  return true
}

/** A short explanation of why the user cannot book, for the interface to show. */
export function whyCannotBook(
  user: SessionUser | null,
  facility: { status: string; minRole: UserRole; bookingPolicy: string },
): string | null {
  if (!user) return 'Sign in to book facilities.'
  if (facility.status === 'inactive') return 'This facility has been withdrawn from booking.'
  if (facility.status === 'maintenance') return 'This facility is under maintenance.'
  if (user.role === 'admin') return null

  if (!roleAtLeast(user.role, facility.minRole)) {
    return `Booking here is limited to ${MIN_ROLE_LABELS[facility.minRole]}. You are signed in as a ${user.role}.`
  }

  if (facility.bookingPolicy === 'supervisor_required' && user.role !== 'supervisor') {
    return 'This is a supervised facility: bookings must be made by a supervisor or an administrator.'
  }

  return null
}
