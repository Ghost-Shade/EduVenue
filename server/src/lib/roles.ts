/**
 * Shared role definitions and the role hierarchy.
 *
 * The ordering here is the whole authorization model in one place: a user may
 * do anything their role permits AND anything a lower-ranked role permits.
 * Keeping it in one table rather than scattering comparisons across routes
 * means "can a supervisor book this?" has exactly one answer.
 */

export type UserRole = 'student' | 'rep' | 'supervisor' | 'admin'

export const USER_ROLES: readonly UserRole[] = ['student', 'rep', 'supervisor', 'admin']

/**
 * Higher rank is more privileged.
 *
 * `student` sits below `rep` deliberately: students can browse and view
 * schedules, but booking requires the class-representative role. A facility
 * whose `min_role` is 'rep' therefore rejects students, which is the behaviour
 * the brief requires.
 */
export const ROLE_RANK: Record<UserRole, number> = {
  student: 0,
  rep: 1,
  supervisor: 2,
  admin: 3,
}

/** Human-readable labels for the interface. */
export const ROLE_LABELS: Record<UserRole, string> = {
  student: 'Student',
  rep: 'Class representative',
  supervisor: 'Supervisor',
  admin: 'Facility administrator',
}

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value)
}

/** True when `role` is at least as privileged as `minimum`. */
export function roleAtLeast(role: UserRole, minimum: UserRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum]
}
