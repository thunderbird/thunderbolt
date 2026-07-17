/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ReactNode } from 'react'

type PageHeaderProps = {
  title: string
  children?: ReactNode
}

/**
 * Consistent page header with title and optional action buttons.
 *
 * @example
 * ```tsx
 * <PageHeader title="Models">
 *   <Button size="icon" className="bg-card">
 *     <Plus />
 *   </Button>
 * </PageHeader>
 * ```
 */
export const PageHeader = ({ title, children }: PageHeaderProps) => (
  <div className="flex min-h-[var(--touch-height-xl)] items-center justify-between">
    <h1 className="text-2xl font-bold tracking-tight text-primary">{title}</h1>
    {/* pr-2 pulls the actions in so icon buttons center-align with list rows'
        trailing controls (rows carry their own horizontal inset) and sit at
        the same x across settings pages. */}
    <div className="flex items-center gap-2 pr-2">{children}</div>
  </div>
)
