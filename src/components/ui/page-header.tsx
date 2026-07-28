/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

import { useMobileForegroundPortalTarget } from '@/components/ui/mobile-foreground-portal'
import { useIsMobile } from '@/hooks/use-mobile'

type PageHeaderProps = {
  title: string
  children?: ReactNode
}

/**
 * Consistent page header with title and optional action buttons.
 *
 * Desktop: an in-flow row — title left, actions right. Mobile: the title
 * joins the floating app-header row (centered between the sidebar toggle and
 * any top-right control, mirroring the modal shells) and the in-flow row
 * disappears; actions place themselves (`PageCreateAction` becomes the
 * bottom pill, `PageSearch.Button` the top-right circle). The mobile chrome
 * portal belongs to the movable foreground shell.
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
export const PageHeader = ({ title, children }: PageHeaderProps) => {
  const { isMobile } = useIsMobile()
  const portalTarget = useMobileForegroundPortalTarget()

  if (isMobile) {
    return (
      <>
        {portalTarget &&
          createPortal(
            <div
              className="pointer-events-none fixed left-1/2 z-30 flex h-[var(--touch-height-lg)] max-w-[50vw] -translate-x-1/2 items-center"
              style={{ top: 'var(--header-control-top)' }}
            >
              <h1 className="truncate text-[length:var(--font-size-body)] font-semibold text-foreground">{title}</h1>
            </div>,
            portalTarget,
          )}
        {children}
      </>
    )
  }

  return (
    <div className="flex min-h-[var(--touch-height-xl)] items-center justify-between">
      <h1 className="text-2xl font-bold tracking-tight text-primary">{title}</h1>
      {/* pr-2 pulls the actions in so icon buttons center-align with list rows'
          trailing controls (rows carry their own horizontal inset) and sit at
          the same x across settings pages. */}
      <div className="flex items-center gap-2 pr-2">{children}</div>
    </div>
  )
}
