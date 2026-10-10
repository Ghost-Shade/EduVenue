/**
 * The shape of everything the API returns.
 *
 * These are written by hand rather than generated, and they mirror
 * `server/src/services/*.ts`. They are the CONTRACT: if the server changes a
 * field name, TypeScript should fail here rather than the interface rendering
 * `undefined` somewhere quietly.
 */

export type UserRole = 'student' | 'rep' | 'supervisor' | 'admin'

export interface SessionUser {
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

export interface DemoAccount {
  email: string
  displayName: string
  role: UserRole
  department: string | null
}

export interface DemoAccounts {
  accounts: DemoAccount[]
  password: string | null
  enabled: boolean
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
