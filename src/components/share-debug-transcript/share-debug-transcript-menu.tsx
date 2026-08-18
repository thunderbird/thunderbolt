/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Button, mutedIconButtonClass } from '@/components/ui/button'
import { mobileHeaderControlFillClass } from '@/components/ui/modal-styles'
import { ResponsiveActionMenu } from '@/components/ui/responsive-action-menu'
import { cn } from '@/lib/utils'
import { Bug, MoreHorizontal } from 'lucide-react'

type ShareDebugTranscriptMenuProps = {
  open: boolean
  disabled: boolean
  onOpenChange: (open: boolean) => void
  onShare: () => void
}

const desktopMenu = {
  align: 'end' as const,
  className: 'min-w-56',
  onCloseAutoFocus: (event: Event) => event.preventDefault(),
}

export const ShareDebugTranscriptMenu = ({ open, disabled, onOpenChange, onShare }: ShareDebugTranscriptMenuProps) => (
  <ResponsiveActionMenu
    open={open}
    onOpenChange={onOpenChange}
    trigger={
      <Button
        variant="ghost"
        size="icon"
        className={cn(mutedIconButtonClass, mobileHeaderControlFillClass)}
        aria-label="Chat actions"
      >
        <MoreHorizontal className="size-[var(--icon-size-default)]" />
      </Button>
    }
    title="Chat actions"
    desktopMenu={desktopMenu}
    actions={[
      {
        label: 'Share debug transcript',
        icon: <Bug className="size-4" />,
        onSelect: onShare,
        disabled,
      },
    ]}
  />
)
