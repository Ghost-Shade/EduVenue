/**
 * Session state for the whole application.
 *
 * The session lives in an httpOnly cookie, so JavaScript cannot read it - which
 * is the point, since a token readable by script is a token stealable by script.
 * The client therefore learns who it is by asking the server, and that answer is
 * the single source of truth held here.
 *
 * `status` is separate from `user` on purpose: "still finding out" and "nobody
 * is signed in" are different states, and conflating them causes a protected
 * page to flash a sign-in redirect before the cookie has been checked.
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

import { api } from '../lib/api'
import type { SessionUser } from '../lib/types'

interface AuthContextValue {
  user: SessionUser | null
  status: 'loading' | 'ready'
  signIn: (email: string, password: string) => Promise<SessionUser>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [user, setUser] = useState<SessionUser | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready'>('loading')

  useEffect(() => {
    let cancelled = false

    api
      .me()
      .then((resolved) => {
        if (!cancelled) setUser(resolved)
      })
      .catch(() => {
        // A failure here means the session could not be established, not that
        // the application is broken. Treat it as signed out; the sign-in page
        // will surface a connection problem if there is one.
        if (!cancelled) setUser(null)
      })
      .finally(() => {
        if (!cancelled) setStatus('ready')
      })

    return () => {
      cancelled = true
    }
  }, [])

  const signIn = useCallback(async (email: string, password: string) => {
    const resolved = await api.login(email, password)
    setUser(resolved)
    return resolved
  }, [])

  const signOut = useCallback(async () => {
    try {
      await api.logout()
    } finally {
      // Even if the request failed, this browser should stop presenting itself
      // as signed in.
      setUser(null)
    }
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({ user, status, signIn, signOut }),
    [user, status, signIn, signOut],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext)

  if (!context) {
    throw new Error('useAuth was used outside an AuthProvider.')
  }

  return context
}
