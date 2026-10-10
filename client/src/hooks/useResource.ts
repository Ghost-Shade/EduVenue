/**
 * A minimal data-loading hook.
 *
 * Every page in this application has the same three states - loading, failed,
 * loaded - and the same need to try again. Writing that out per page produces
 * three chances per page to forget the cancelled-request guard, which is how
 * "setState on an unmounted component" warnings and out-of-order responses get
 * in. It lives here once instead.
 */
import { useCallback, useEffect, useState } from 'react'

import { ApiError } from '../lib/api'

export interface Resource<T> {
  data: T | null
  error: ApiError | null
  loading: boolean
  /** Re-runs the loader, e.g. after a failed request or a successful change. */
  reload: () => void
}

export function useResource<T>(load: () => Promise<T>, deps: unknown[]): Resource<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [loading, setLoading] = useState(true)
  const [attempt, setAttempt] = useState(0)

  const reload = useCallback(() => {
    setAttempt((value) => value + 1)
  }, [])

  useEffect(() => {
    let cancelled = false

    setLoading(true)
    setError(null)

    load()
      .then((resolved) => {
        // The guard matters: without it, a slow first request can land after a
        // fast second one and overwrite the newer data with stale data.
        if (!cancelled) setData(resolved)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setError(
          cause instanceof ApiError
            ? cause
            : new ApiError(0, 'UNEXPECTED_ERROR', 'Something went wrong loading this page.', undefined),
        )
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, attempt])

  return { data, error, loading, reload }
}
