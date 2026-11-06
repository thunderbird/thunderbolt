/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { SidebarMenuButton } from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'

/** One disclosure style for projects, recent chats, and the chats inside a project. */
export const SidebarListToggle = ({
  showAll,
  onToggle,
  controls,
  label,
  className,
}: {
  showAll: boolean
  onToggle: () => void
  controls: string
  label: string
  className?: string
}) => (
  <SidebarMenuButton
    onClick={onToggle}
    aria-expanded={showAll}
    aria-controls={controls}
    aria-label={label}
    tooltip={label}
    className={cn('cursor-pointer text-[length:var(--font-size-sm)] text-muted-foreground', className)}
  >
    {showAll ? <Trans>Show less</Trans> : <Trans>Show more</Trans>}
  </SidebarMenuButton>
)
