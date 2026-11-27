/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { useLingui } from '@lingui/react/macro'
import { Skeleton } from '@/components/ui/skeleton'

/** Placeholder rows while an admin list loads its first page. */
export const ListSkeleton = ({ rows = 5, variant = 'card' }: { rows?: number; variant?: 'card' | 'flat' }) => {
  const { t } = useLingui()
  return (
    // Shaped like the bordered row cards the list loads into.
    // `flat` for content that sits on the surface: a panel's lists, such as a connection's sync errors.
    <div
      role="status"
      aria-label={t`Loading`}
      className={variant === 'card' ? 'flex flex-col gap-4' : 'flex flex-col gap-1'}
    >
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className={
            variant === 'card'
              ? 'flex flex-col gap-1.5 rounded-xl border border-border px-4 py-3'
              : 'flex flex-col gap-1.5 px-2 py-1.5'
          }
        >
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  )
}
