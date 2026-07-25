/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Paperclip, Plug, Plus } from 'lucide-react'
import { useState } from 'react'

import { ResponsiveActionMenu, type ResponsiveActionMenuAction } from '@/components/ui/responsive-action-menu'

type ChatAddMenuProps = {
  onUploadFile: () => void
  onOpenConnections: () => void
}

/**
 * The composer's "+" menu for attaching files and opening connections.
 * Renders a dropdown on desktop and a bottom card drawer on mobile.
 */
export const ChatAddMenu = ({ onUploadFile, onOpenConnections }: ChatAddMenuProps) => {
  const [open, setOpen] = useState(false)

  const actions: ResponsiveActionMenuAction[] = [
    {
      label: 'Upload file',
      icon: <Paperclip className="size-[var(--icon-size-sm)] text-muted-foreground" />,
      onSelect: onUploadFile,
    },
    {
      label: 'Connections',
      icon: <Plug className="size-[var(--icon-size-sm)] text-muted-foreground" />,
      onSelect: onOpenConnections,
    },
  ]

  return (
    <ResponsiveActionMenu
      open={open}
      onOpenChange={setOpen}
      title="Add to chat"
      actions={actions}
      desktopMenu={{ side: 'bottom', align: 'start', className: 'min-w-44' }}
      trigger={
        <button
          type="button"
          aria-label="Add to chat"
          title="Add to chat"
          // aria-expanded covers both branches: the shared menu sets it on
          // mobile, Radix's DropdownMenuTrigger sets it on desktop.
          className="flex size-[var(--touch-height-control)] shrink-0 cursor-pointer items-center justify-center rounded-[var(--radius-control)] text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground"
        >
          <Plus className="size-[var(--icon-size-sm)]" />
        </button>
      }
    />
  )
}
