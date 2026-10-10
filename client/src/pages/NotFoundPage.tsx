import { Link } from 'react-router-dom'

import { buttonPrimary } from '../components/ui'

export function NotFoundPage(): JSX.Element {
  return (
    <div className="surface p-10 text-center max-w-lg mx-auto">
      <p className="text-sm font-medium text-brand-600">404</p>
      <h1 className="text-2xl mt-1 mb-2">That page does not exist</h1>
      <p className="text-campus-600">
        The address may be mistyped, or the thing it pointed at may have been removed.
      </p>
      <Link to="/" className={`${buttonPrimary} mt-6`}>
        Back to the dashboard
      </Link>
    </div>
  )
}
