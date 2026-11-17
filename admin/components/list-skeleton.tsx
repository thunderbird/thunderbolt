/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { useLingui } from '@lingui/react/macro'
import { Skeleton } from '@/components/ui/skeleton'

/** Placeholder rows while an admin list loads its first page. */
export const ListSkeleton = ({ rows = 5 }: { rows?: number }) => {
  const { t } = useLingui()
  return (
    <div role="status" aria-label={t`Loading`} className="flex flex-col gap-2">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-3 px-2 py-2">
          <Skeleton className="size-10 shrink-0" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  )
}
