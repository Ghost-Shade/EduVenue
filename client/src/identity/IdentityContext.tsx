/**
 * Who the interface is acting as, for the whole application.
 *
 * ===========================================================================
 * THERE IS NO SIGN-IN, SO THERE IS NO SIGNED-OUT STATE
 * ===========================================================================
 *
 * The application opens as a class representative and every other identity is a
 * click away. Nothing here authenticates anybody: the server believes whatever
 * profile id the cookie carries, and falls back to its own default when there is
 * no cookie at all. See services/identityService.ts on the API side for what that
 * trades away, and README.md for why it was done.
 *
 * The one thing this context still has is THREE STATES, and they are not
 * decoration:
 *
 *   loading - the server has not answered yet
 *   ready   - we know who we are acting as
 *   failed  - the server could not be reached
 *
 * `failed` used to mean "show the sign-in page". It now means something more
 * honest and more useful: the API is unreachable, so say so and offer to try
 * again, rather than pretending to be an identity the server has not confirmed.
 * Rendering the interface with a guessed local identity would let a user fill in
 * a booking form against a server that is not answering.
 *
 * ===========================================================================
 * WHY THE IDENTITY IS THE SERVER'S ANSWER, NOT A LOCAL CHOICE
 * ===========================================================================
 *
 * The switcher does not set local state and hope. It posts to the server, the
 * server sets the cookie, and the new state comes back in the response. So the
 * word "acting as" in the header is always something the SERVER has agreed to,
 * which is what makes the role shown and the role enforced the same thing.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

import { api, ApiError } from '../lib/api'
import type { CurrentUser, IdentityOption } from '../lib/types'

interface IdentityContextValue {
  /** Null only while loading, or when the server could not be reached. */
  user: CurrentUser | null
  /** Everyone the switcher can offer. Empty until the server has answered. */
  identities: IdentityOption[]
  status: 'loading' | 'ready' | 'failed'
  /** Set when `status` is 'failed', so the gate can show the real reason. */
  error: ApiError | null
  /** Adopts another identity, server round trip included. */
  switchIdentity: (userId: string) => Promise<void>
  /** Returns to the server's default identity. */
  clearIdentity: () => Promise<void>
  /** Re-runs the initial load, for the retry button. */
  reload: () => void
}

const IdentityContext = createContext<IdentityContextValue | null>(null)

export function IdentityProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, setState] = useState<{ user: CurrentUser; identities: IdentityOption[] } | null>(
    null,
  )
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [error, setError] = useState<ApiError | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setStatus('loading')
    setError(null)

    try {
      setState(await api.identity())
      setStatus('ready')
    } catch (cause) {
      setState(null)
      setError(
        cause instanceof ApiError
          ? cause
          : new ApiError(0, 'UNEXPECTED_ERROR', 'Could not establish who you are acting as.', undefined),
      )
      setStatus('failed')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const switchIdentity = useCallback(async (userId: string): Promise<void> => {
    // Deliberately NOT caught here. A failed switch must not silently leave the
    // header showing an identity the server never accepted, so the error is
    // raised to the caller, which is the switcher, which shows it.
    const next = await api.switchIdentity(userId)
    setState({ user: next.user, identities: next.identities })
    setStatus('ready')
    setError(null)
  }, [])

  const clearIdentity = useCallback(async (): Promise<void> => {
    const next = await api.clearIdentity()
    setState({ user: next.user, identities: next.identities })
    setStatus('ready')
    setError(null)
  }, [])

  const value = useMemo<IdentityContextValue>(
    () => ({
      user: state?.user ?? null,
      identities: state?.identities ?? [],
      status,
      error,
      switchIdentity,
      clearIdentity,
      reload: () => void load(),
    }),
    [state, status, error, switchIdentity, clearIdentity, load],
  )

  return <IdentityContext.Provider value={value}>{children}</IdentityContext.Provider>
}

export function useIdentity(): IdentityContextValue {
  const context = useContext(IdentityContext)

  if (!context) {
    throw new Error('useIdentity was used outside an IdentityProvider.')
  }

  return context
}
