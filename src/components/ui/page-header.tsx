/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { cn } from '@/lib/utils'
import type { ReactNode } from 'react'

type PageHeaderProps = {
  title: string
  children?: ReactNode
  /** Override the default title size/weight (e.g. `text-[32px]`). */
  titleClassName?: string
}

/**
 * Consistent page header with title and optional action buttons.
 *
 * @example
 * ```tsx
 * <PageHeader title="Models">
 *   <Button size="icon" className="rounded-lg bg-card hover:bg-accent">
 *     <Plus />
 *   </Button>
 * </PageHeader>
 * ```
 */
export const PageHeader = ({ title, children, titleClassName }: PageHeaderProps) => (
  <div className="flex min-h-[var(--touch-height-xl)] items-center justify-between">
    <h1 className={cn('text-[24px] leading-[32px] font-bold tracking-tight text-primary', titleClassName)}>{title}</h1>
    {/* pr-2 matches the skills page's header actions, which are pulled in to
        center-align the + button with the list rows' trailing toggles — kept
        identical here so page-level + buttons sit at the same x across
        settings pages. */}
    <div className="flex items-center gap-2 pr-2">{children}</div>
  </div>
)
