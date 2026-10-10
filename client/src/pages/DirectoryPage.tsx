/**
 * The facility directory.
 *
 * Two decisions worth naming:
 *
 *  1. THE FILTERS ARE APPLIED ON THE SERVER. The client sends the search term
 *     and the server runs the query. Filtering a fully-loaded list in the
 *     browser would look identical in a demo and fall over the moment there are
 *     more facilities than fit in one response.
 *
 *  2. AN EMPTY RESULT SAYS WHICH FILTERS CAUSED IT, and offers to clear them. A
 *     bare "no facilities found" leaves the user hunting for the filter they
 *     forgot they set.
 */
import { useEffect, useMemo, useState } from 'react'

import { api } from '../lib/api'
import type { Category, FacilityFilters } from '../lib/types'
import { useResource } from '../hooks/useResource'
import { FacilityCard } from '../components/FacilityCard'
import { EmptyState, ErrorBanner, Field, Loading, buttonSecondary, inputClass } from '../components/ui'

const SORTS: Array<{ value: NonNullable<FacilityFilters['sort']>; label: string }> = [
  { value: 'name', label: 'Name' },
  { value: 'capacity', label: 'Capacity' },
  { value: 'category', label: 'Category' },
  { value: 'building', label: 'Building' },
]

export function DirectoryPage(): JSX.Element {
  const [searchInput, setSearchInput] = useState('')
  const [q, setQ] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [building, setBuilding] = useState('')
  const [minCapacity, setMinCapacity] = useState('')
  const [sort, setSort] = useState<NonNullable<FacilityFilters['sort']>>('name')
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc')

  // Typing should not fire a request per keystroke.
  useEffect(() => {
    const timer = window.setTimeout(() => setQ(searchInput.trim()), 300)
    return () => window.clearTimeout(timer)
  }, [searchInput])

  const reference = useResource(
    async () => {
      const [categories, buildings] = await Promise.all([api.categories(), api.buildings()])
      return { categories, buildings }
    },
    [],
  )

  const filters = useMemo<FacilityFilters>(
    () => ({
      // Absent rather than empty: `queryString` in api.ts drops empty values, so
      // an unset filter never reaches the server as `?q=`.
      q: q || undefined,
      categoryId: categoryId || undefined,
      building: building || undefined,
      minCapacity: minCapacity ? Number(minCapacity) : undefined,
      sort,
      direction,
    }),
    [q, categoryId, building, minCapacity, sort, direction],
  )

  const facilities = useResource(() => api.facilities(filters), [filters])

  const activeFilters = [q, categoryId, building, minCapacity].filter(Boolean).length

  function clearFilters(): void {
    setSearchInput('')
    setQ('')
    setCategoryId('')
    setBuilding('')
    setMinCapacity('')
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl">Find a room</h1>
        <p className="text-campus-600 mt-1">
          Search across lecture venues, computing and science laboratories, collaborative spaces and
          more.
        </p>
      </header>

      <form
        className="surface p-5 space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          setQ(searchInput.trim())
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="sm:col-span-2">
            <Field label="Search" htmlFor="q" hint="Matches name, building, category and description.">
              <input
                id="q"
                type="search"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="e.g. laboratory, ICT Centre, projector"
                className={inputClass}
              />
            </Field>
          </div>

          <Field label="Category" htmlFor="category">
            <select
              id="category"
              value={categoryId}
              onChange={(event) => setCategoryId(event.target.value)}
              className={inputClass}
            >
              <option value="">All categories</option>
              {(reference.data?.categories ?? []).map((category: Category) => (
                <option key={category.id} value={category.id}>
                  {category.name} ({category.facilityCount})
                </option>
              ))}
            </select>
          </Field>

          <Field label="Building" htmlFor="building">
            <select
              id="building"
              value={building}
              onChange={(event) => setBuilding(event.target.value)}
              className={inputClass}
            >
              <option value="">All buildings</option>
              {(reference.data?.buildings ?? []).map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Minimum capacity" htmlFor="minCapacity" hint="Seats needed.">
            <input
              id="minCapacity"
              type="number"
              min={1}
              max={5000}
              value={minCapacity}
              onChange={(event) => setMinCapacity(event.target.value)}
              placeholder="Any"
              className={inputClass}
            />
          </Field>

          <Field label="Sort by" htmlFor="sort">
            <select
              id="sort"
              value={sort}
              onChange={(event) => setSort(event.target.value as NonNullable<FacilityFilters['sort']>)}
              className={inputClass}
            >
              {SORTS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Order" htmlFor="direction">
            <select
              id="direction"
              value={direction}
              onChange={(event) => setDirection(event.target.value as 'asc' | 'desc')}
              className={inputClass}
            >
              <option value="asc">Ascending</option>
              <option value="desc">Descending</option>
            </select>
          </Field>
        </div>

        <div className="flex items-center justify-between gap-3 pt-1">
          <p className="text-sm text-campus-500">
            {activeFilters > 0
              ? `${activeFilters} filter${activeFilters === 1 ? '' : 's'} applied`
              : 'No filters applied'}
          </p>

          {activeFilters > 0 ? (
            <button type="button" onClick={clearFilters} className={buttonSecondary}>
              Clear filters
            </button>
          ) : null}
        </div>
      </form>

      {facilities.loading ? (
        <Loading label="Loading facilities…" />
      ) : facilities.error ? (
        <ErrorBanner error={facilities.error} onRetry={facilities.reload} title="Could not load facilities" />
      ) : (facilities.data?.count ?? 0) === 0 ? (
        <EmptyState
          title="No facilities match those filters"
          description="Nothing in the directory matches the combination of filters you have set. Clearing them will show every facility again."
          action={{ label: 'Clear filters', onClick: clearFilters }}
        />
      ) : (
        <section>
          <div className="flex items-end justify-between mb-4">
            <h2 className="text-lg">
              {facilities.data?.count} facilit{facilities.data?.count === 1 ? 'y' : 'ies'}
            </h2>
            <button type="button" onClick={facilities.reload} className="text-sm text-brand-600 hover:underline">
              Refresh
            </button>
          </div>

          <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            {(facilities.data?.facilities ?? []).map((facility) => (
              <FacilityCard key={facility.id} facility={facility} />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
