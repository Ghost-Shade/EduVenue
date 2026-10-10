/**
 * A facility in the directory.
 *
 * The card answers the three questions a person actually has when choosing a
 * room - where is it, how many does it hold, and can I book it - and nothing
 * else. Everything the card does not answer is on the detail page, which keeps
 * the list scannable.
 */
import { Link } from 'react-router-dom'

import { mayBook, whyCannotBook } from '../lib/roles'
import type { Facility } from '../lib/types'
import { useIdentity } from '../identity/IdentityContext'
import { FacilityStatusBadge, Tag } from './ui'

export function FacilityCard({ facility }: { facility: Facility }): JSX.Element {
  const { user } = useIdentity()

  const bookable = mayBook(user, facility)
  const reason = whyCannotBook(user, facility)

  return (
    <article className="surface p-5 flex flex-col">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-lg leading-snug">
            <Link
              to={`/facilities/${facility.id}`}
              className="hover:text-brand-700 focus-visible:text-brand-700"
            >
              {facility.name}
            </Link>
          </h3>
          <p className="text-sm text-campus-500 mt-0.5">
            {facility.building} · {facility.categoryName}
          </p>
        </div>
        <FacilityStatusBadge status={facility.status} />
      </div>

      <p className="text-sm text-campus-600 mt-3 line-clamp-2">{facility.description}</p>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <div>
          <dt className="text-campus-500">Capacity</dt>
          <dd className="text-campus-900 font-medium tabular">{facility.capacity}</dd>
        </div>
        <div>
          <dt className="text-campus-500">Open</dt>
          <dd className="text-campus-900 font-medium tabular">
            {facility.opensAt}-{facility.closesAt}
          </dd>
        </div>
      </dl>

      {facility.equipment.length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {facility.equipment.slice(0, 3).map((item) => (
            <Tag key={item}>{item}</Tag>
          ))}
          {facility.equipment.length > 3 ? <Tag>+{facility.equipment.length - 3} more</Tag> : null}
        </div>
      ) : null}

      <div className="mt-auto pt-5 flex items-center justify-between gap-3">
        <Link to={`/facilities/${facility.id}`} className="text-sm font-medium text-brand-600 hover:underline">
          View schedule
        </Link>

        {bookable ? (
          <Link
            to={`/facilities/${facility.id}/book`}
            className="text-sm font-medium text-brand-600 hover:underline"
          >
            Book this room
          </Link>
        ) : (
          // Said plainly, and in one line. A disabled button with no explanation
          // is the most common way a booking interface wastes people's time.
          <span className="text-xs text-campus-500 text-right max-w-[16rem]" title={reason ?? undefined}>
            {reason}
          </span>
        )}
      </div>
    </article>
  )
}
