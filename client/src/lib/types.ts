/**
 * The shape of everything the API returns.
 *
 * These are written by hand rather than generated, and they mirror
 * `server/src/services/*.ts`. They are the CONTRACT: if the server changes a
 * field name, TypeScript should fail here rather than the interface rendering
 * `undefined` somewhere quietly.
 */

export type UserRole = 'student' | 'rep' | 'supervisor' | 'admin'

/**
 * The identity the interface is currently acting as.
 *
 * Called `CurrentUser` rather than `SessionUser` because there is no session:
 * authentication was removed and the server simply reports which profile the
 * caller has adopted. See services/identityService.ts on the API side.
 */
export interface CurrentUser {
  id: string
  email: string
  displayName: string
  role: UserRole
  roleLabel: string
  department: string | null
}

export type FacilityStatus = 'active' | 'inactive' | 'maintenance'
export type BookingPolicy = 'open' | 'restricted' | 'supervisor_required'

export interface Facility {
  id: string
  name: string
  categoryId: string
  categoryName: string
  building: string
  locationDescription: string
  capacity: number
  description: string
  equipment: string[]
  accessibility: string[]
  status: FacilityStatus
  opensAt: string
  closesAt: string
  closedDays: number[]
  slotMinutes: number
  bufferMinutes: number
  bookingPolicy: BookingPolicy
  minRole: UserRole
  allowedActivities: string[]
  createdAt: string
  updatedAt: string
}

export interface Category {
  id: string
  name: string
  description: string
  sortOrder: number
  facilityCount: number
}

export interface BusyPeriod {
  id: string
  kind: 'booking' | 'block'
  activityPurpose: string
  expectedAttendance: number | null
  startTime: string
  endTime: string
}

export interface FreeSlot {
  startTime: string
  endTime: string
  minutes: number
}

export interface Availability {
  facility: Facility
  date: string
  window: { opensAt: string; closesAt: string } | null
  closedReason: string | null
  busy: BusyPeriod[]
  freeSlots: FreeSlot[]
  isPast: boolean
}

export type BookingStatus = 'confirmed' | 'cancelled' | 'completed'

export interface Booking {
  id: string
  reference: string
  facilityId: string
  facilityName: string
  facilityBuilding: string
  facilityCategory: string
  bookedById: string
  bookedByName: string
  activityPurpose: string
  expectedAttendance: number
  startTime: string
  endTime: string
  durationMinutes: number
  status: BookingStatus
  createdAt: string
  updatedAt: string
  cancelledAt: string | null
  cancelledByName: string | null
  cancellationReason: string | null
}

export interface Recommendation {
  facility: Facility
  score: number
  reasons: string[]
  capacityFitPercent: number
}

export interface Rejection {
  facilityId: string
  facilityName: string
  code: string
  reason: string
}

export interface AlternativeSuggestion {
  facilityId: string
  facilityName: string
  building: string
  date: string
  startTime: string
  endTime: string
  displayDate: string
  note: string
}

export interface RecommendationResult {
  requested: {
    date: string
    startTime: string
    endTime: string
    durationMinutes: number
    expectedAttendance: number
    activityPurpose: string
  }
  recommendations: Recommendation[]
  consideredCount: number
  rejected: Rejection[]
  alternatives: AlternativeSuggestion[]
  problem: string | null
}

/** One selectable identity, for the switcher in the header. */
export interface IdentityOption {
  id: string
  email: string
  displayName: string
  role: UserRole
  roleLabel: string
  department: string | null
}

/**
 * The whole of `GET/POST/DELETE /api/identity`.
 *
 * `user` is non-null and the type says so: the server always has an identity to
 * report, because an absent or unknown cookie resolves to a default rather than
 * to a signed-out state. Only the client can be in a state without one, and that
 * is during loading or after a failure to reach the server - which is why the
 * context's `user` is nullable while this is not.
 */
export interface IdentityState {
  user: CurrentUser
  identities: IdentityOption[]
}

export interface FacilityFilters {
  q?: string
  categoryId?: string
  building?: string
  activity?: string
  minCapacity?: number
  sort?: 'name' | 'capacity' | 'category' | 'building'
  direction?: 'asc' | 'desc'
}
