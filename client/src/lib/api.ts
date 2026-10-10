/**
 * The API client.
 *
 * ===========================================================================
 * THIS FILE IS A CONVENIENCE, NOT A SECURITY BOUNDARY
 * ===========================================================================
 *
 * It hides the fetch boilerplate and turns error responses into thrown
 * `ApiError`s. Nothing here protects anything: every rule this interface appears
 * to enforce is enforced again on the server, because a request can be crafted
 * with curl and never load this code at all. Hiding a button is usability;
 * the server's role guards are the control.
 *
 * Cookies: the Vite dev server proxies `/api` to the API on port 4000, so the
 * browser sees one origin and the session cookie is sent normally. That is why
 * there is no CORS configuration and no token juggling anywhere in this client.
 */
import type {
  Availability,
  Booking,
  Category,
  DemoAccounts,
  Facility,
  FacilityFilters,
  RecommendationResult,
  SessionUser,
} from './types'

/** A failure the API described deliberately. */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: unknown

  constructor(status: number, code: string, message: string, details: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }

  /**
   * Field-level messages, keyed by field name.
   *
   * Lets a form put "Capacity must be a positive number" next to the input that
   * caused it instead of in a banner at the top of the page.
   */
  get fieldErrors(): Record<string, string> {
    const details = this.details

    if (!Array.isArray(details)) return {}

    const map: Record<string, string> = {}
    for (const item of details) {
      if (
        typeof item === 'object' &&
        item !== null &&
        'message' in item &&
        typeof (item as { message: unknown }).message === 'string'
      ) {
        const field = (item as { field?: unknown }).field
        const key = typeof field === 'string' && field.length > 0 ? field : '_form'
        map[key] ??= (item as { message: string }).message
      }
    }

    return map
  }
}

interface ErrorBody {
  error?: { code?: unknown; message?: unknown; details?: unknown }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response

  try {
    response = await fetch(path, {
      // Send the session cookie on same-origin requests. Same-origin is already
      // the default, but stating it means a future change to the proxy setup is
      // a visible decision rather than a silent breakage.
      credentials: 'same-origin',
      headers: init.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      ...init,
    })
  } catch {
    // A network-level failure. The message deliberately avoids implying the
    // server said no - it may simply not be running.
    throw new ApiError(
      0,
      'NETWORK_ERROR',
      'Could not reach the server. Check that the API is running, then try again.',
      undefined,
    )
  }

  if (response.status === 204) {
    return undefined as T
  }

  const text = await response.text()
  let parsed: unknown = null

  if (text.length > 0) {
    try {
      parsed = JSON.parse(text)
    } catch {
      // A non-JSON body means something is wrong well below the API (a proxy
      // error page, for instance). Do not show it to the user as-is.
      throw new ApiError(
        response.status,
        'UNREADABLE_RESPONSE',
        'The server returned a response this application could not read.',
        undefined,
      )
    }
  }

  if (!response.ok) {
    const body = (parsed ?? {}) as ErrorBody
    const code = typeof body.error?.code === 'string' ? body.error.code : 'UNKNOWN_ERROR'
    const message =
      typeof body.error?.message === 'string'
        ? body.error.message
        : 'Something went wrong. Please try again.'

    throw new ApiError(response.status, code, message, body.error?.details)
  }

  return parsed as T
}

function queryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') {
      search.set(key, String(value))
    }
  }

  const rendered = search.toString()
  return rendered.length > 0 ? `?${rendered}` : ''
}

export const api = {
  // --- session ----------------------------------------------------------
  async login(email: string, password: string): Promise<SessionUser> {
    const body = await request<{ user: SessionUser }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })
    return body.user
  },

  async logout(): Promise<void> {
    await request<void>('/api/auth/logout', { method: 'POST' })
  },

  async me(): Promise<SessionUser | null> {
    const body = await request<{ user: SessionUser | null }>('/api/auth/me')
    return body.user
  },

  async demoAccounts(): Promise<DemoAccounts> {
    return request<DemoAccounts>('/api/auth/demo-accounts')
  },

  // --- directory --------------------------------------------------------
  async facilities(filters: FacilityFilters = {}): Promise<{ facilities: Facility[]; count: number }> {
    return request(
      `/api/facilities${queryString({
        q: filters.q,
        categoryId: filters.categoryId,
        building: filters.building,
        activity: filters.activity,
        minCapacity: filters.minCapacity,
        sort: filters.sort,
        direction: filters.direction,
      })}`,
    )
  },

  async facility(id: string): Promise<Facility> {
    const body = await request<{ facility: Facility }>(`/api/facilities/${encodeURIComponent(id)}`)
    return body.facility
  },

  async availability(id: string, date: string): Promise<Availability> {
    const body = await request<{ availability: Availability }>(
      `/api/facilities/${encodeURIComponent(id)}/availability${queryString({ date })}`,
    )
    return body.availability
  },

  async categories(): Promise<Category[]> {
    const body = await request<{ categories: Category[] }>('/api/facilities/categories')
    return body.categories
  },

  async buildings(): Promise<string[]> {
    const body = await request<{ buildings: string[] }>('/api/facilities/buildings')
    return body.buildings
  },

  async activities(): Promise<string[]> {
    const body = await request<{ activities: string[] }>('/api/facilities/activities')
    return body.activities
  },

  // --- bookings ---------------------------------------------------------
  async myBookings(scope: 'upcoming' | 'past' | 'all'): Promise<Booking[]> {
    const body = await request<{ bookings: Booking[] }>(`/api/bookings/mine${queryString({ scope })}`)
    return body.bookings
  },

  async booking(id: string): Promise<Booking> {
    const body = await request<{ booking: Booking }>(`/api/bookings/${encodeURIComponent(id)}`)
    return body.booking
  },

  async createBooking(input: {
    facilityId: string
    activityPurpose: string
    expectedAttendance: number
    date: string
    startTime: string
    endTime: string
  }): Promise<Booking> {
    const body = await request<{ booking: Booking }>('/api/bookings', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    return body.booking
  },

  async cancelBooking(id: string, reason: string): Promise<Booking> {
    const body = await request<{ booking: Booking }>(
      `/api/bookings/${encodeURIComponent(id)}/cancel`,
      { method: 'POST', body: JSON.stringify({ reason: reason || undefined }) },
    )
    return body.booking
  },

  async recommend(input: {
    date: string
    startTime: string
    endTime: string
    expectedAttendance: number
    activityPurpose: string
    preferredCategoryId?: string
    preferredBuilding?: string
    requiredEquipment?: string[]
  }): Promise<RecommendationResult> {
    const body = await request<{ result: RecommendationResult }>('/api/bookings/recommendations', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    return body.result
  },
}
