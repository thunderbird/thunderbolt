/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The empty state for a list page: centered icon, headline, optional
 * explanation, optional call to action.
 *
 * One component so the pages can't drift apart — Tasks and Projects had grown
 * different icon treatments and type scales for the same moment.
 */

import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

type EmptyStateProps = {
  icon: LucideIcon
  title: string
  /** Why the page exists / what to do next. Omit for "no search results", where
   *  the user knows what they were looking for. */
  description?: string
  /** Typically a `Button` that starts the create flow. */
  action?: ReactNode
}

export const EmptyState = ({ icon: Icon, title, description, action }: EmptyStateProps) => (
  <div className="flex items-center justify-center p-16">
    <div className="flex max-w-sm flex-col items-center gap-4 text-center">
      <div className="inline-block rounded-full bg-primary/10 p-4">
        <Icon className="size-8 text-primary" aria-hidden="true" />
      </div>
      <h3 className="text-xl font-semibold">{title}</h3>
      {description && <p className="text-[length:var(--font-size-sm)] text-muted-foreground">{description}</p>}
      {action}
    </div>
  </div>
)
