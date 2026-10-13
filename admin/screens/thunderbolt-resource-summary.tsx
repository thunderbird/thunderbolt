/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans } from '@lingui/react/macro'
import { ChevronRight } from 'lucide-react'
import { Link } from 'react-router'
import type { ReactNode } from 'react'
import { buttonVariants } from '@/components/ui/button'

/** Read-only resources link to their full editors, retaining normal browser navigation. */
export const ThunderboltResourceSummary = ({
  items,
  path,
  empty,
  description,
  manageLabel,
}: {
  items: { id: string; name: string; description: string; enabled: boolean }[]
  path: string
  empty: ReactNode
  description: ReactNode
  manageLabel: string
}) => (
  <>
    <p className="text-sm text-muted-foreground">{description}</p>
    <ul className="flex flex-col gap-2">
      {items.map((item) => (
        <li key={item.id}>
          <Link
            to={`${path}?edit=${encodeURIComponent(item.id)}`}
            className="flex items-center gap-3 rounded-lg p-2 hover:bg-accent focus-visible:outline-ring"
          >
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="font-medium">{item.name}</span>
              <span className="break-words text-sm text-muted-foreground">{item.description}</span>
              {!item.enabled && (
                <span className="text-xs text-muted-foreground">
                  <Trans>Disabled</Trans>
                </span>
              )}
            </span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </Link>
        </li>
      ))}
    </ul>
    {!items.length && <p className="text-sm text-muted-foreground">{empty}</p>}
    <Link to={path} className={buttonVariants({ variant: 'outline', className: 'self-start' })}>
      {manageLabel}
    </Link>
  </>
)
