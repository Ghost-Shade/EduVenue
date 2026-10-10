/**
 * Sign-in.
 *
 * There is no registration form, and that is a deliberate part of the design
 * rather than an omission: roles are what make a booking trustworthy, and
 * self-service sign-up would let anyone grant themselves the representative
 * role. Accounts are created by the facilities office.
 *
 * The demo shortcuts are shown only when the server reports demo mode is on.
 * `config.ts` forces it off when NODE_ENV=production, so this cannot become a
 * live listing of privileged accounts.
 */
import { useEffect, useState, type FormEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

import { useAuth } from '../auth/AuthContext'
import { api, ApiError } from '../lib/api'
import type { DemoAccount } from '../lib/types'
import { buttonPrimary, buttonSecondary, ErrorBanner, Field, inputClass, Loading } from '../components/ui'

interface LocationState {
  from?: string
}

export function LoginPage(): JSX.Element {
  const { user, status, signIn } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<ApiError | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const [demoAccounts, setDemoAccounts] = useState<DemoAccount[]>([])
  const [demoPassword, setDemoPassword] = useState<string | null>(null)
  const [demoLoading, setDemoLoading] = useState(true)

  const redirectTo = (location.state as LocationState | null)?.from ?? '/'

  // Already signed in: go where they were headed instead of showing a form.
  useEffect(() => {
    if (status === 'ready' && user) {
      navigate(redirectTo, { replace: true })
    }
  }, [status, user, navigate, redirectTo])

  useEffect(() => {
    let cancelled = false

    api
      .demoAccounts()
      .then((result) => {
        if (cancelled) return
        if (result.enabled) {
          setDemoAccounts(result.accounts)
          setDemoPassword(result.password)
        }
      })
      .catch(() => {
        // Demo shortcuts are a convenience. If they cannot be loaded, the form
        // below still works and is still the point of the page.
      })
      .finally(() => {
        if (!cancelled) setDemoLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  async function attemptSignIn(nextEmail: string, nextPassword: string): Promise<void> {
    setSubmitting(true)
    setError(null)

    try {
      await signIn(nextEmail, nextPassword)
      navigate(redirectTo, { replace: true })
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause
          : new ApiError(0, 'UNEXPECTED_ERROR', 'Sign-in failed. Please try again.', undefined),
      )
      setSubmitting(false)
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    void attemptSignIn(email, password)
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 sm:p-6">
      <div className="w-full max-w-4xl grid gap-6 lg:grid-cols-[1.1fr_1fr] items-start">
        <div className="surface p-6 sm:p-8">
          <p className="text-sm font-medium text-brand-600">EduVenue</p>
          <h1 className="text-2xl mt-1 mb-1">Sign in</h1>
          <p className="text-campus-600 text-sm mb-6">
            Campus facilities at a glance, and immediate booking for class representatives.
          </p>

          {error ? (
            <div className="mb-5">
              <ErrorBanner error={error} title="Could not sign you in" />
            </div>
          ) : null}

          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <Field label="Email address" htmlFor="email" required>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className={inputClass}
                placeholder="rep.brian@eduvenue.test"
              />
            </Field>

            <Field label="Password" htmlFor="password" required>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className={inputClass}
              />
            </Field>

            <button type="submit" disabled={submitting} className={`${buttonPrimary} w-full`}>
              {submitting ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <p className="text-xs text-campus-500 mt-4">
            Accounts are issued by the facilities office. There is no self-registration: the role
            attached to an account is what makes a booking trustworthy.
          </p>
        </div>

        <div className="surface p-6 sm:p-8">
          <h2 className="text-lg mb-1">Demonstration accounts</h2>

          {demoLoading ? (
            <Loading label="Checking for demo accounts…" />
          ) : demoAccounts.length === 0 ? (
            <p className="text-sm text-campus-600">
              Demo shortcuts are switched off on this server. Sign in with the credentials you were
              given.
            </p>
          ) : (
            <>
              <p className="text-sm text-campus-600 mb-4">
                Each account shows a different part of the role model. Shared password:{' '}
                <code className="px-1.5 py-0.5 rounded bg-campus-100 text-campus-800">
                  {demoPassword}
                </code>
              </p>

              <ul className="space-y-2">
                {demoAccounts.map((account) => (
                  <li key={account.email}>
                    <button
                      type="button"
                      disabled={submitting}
                      onClick={() => void attemptSignIn(account.email, demoPassword ?? '')}
                      className={`${buttonSecondary} w-full justify-between text-left`}
                    >
                      <span className="min-w-0">
                        <span className="block font-medium text-campus-900 truncate">
                          {account.displayName}
                        </span>
                        <span className="block text-xs text-campus-500 truncate">
                          {account.role} · {account.department ?? '—'}
                        </span>
                      </span>
                      <span className="text-brand-600 text-xs shrink-0">Use</span>
                    </button>
                  </li>
                ))}
              </ul>

              <p className="text-xs text-campus-500 mt-4">
                All accounts and facility data are fictional sample data. The{' '}
                <code>.test</code> domain cannot receive mail.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
