/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLingui } from '@lingui/react/macro'
import { Paperclip, Plug, Plus } from 'lucide-react'
import { useState } from 'react'

import { ResponsiveActionMenu, type ResponsiveActionMenuAction } from '@/components/ui/responsive-action-menu'

type ChatAddMenuProps = {
  /** Omitted when the selected agent takes no attachments, which hides the action. */
  onUploadFile?: () => void
  /** Omitted when the Connections route is unreachable (minimal mode), which hides the action. */
  onOpenConnections?: () => void
}

/**
 * The composer's "+" menu for attaching files and opening connections.
 * Renders a dropdown on desktop and a bottom card drawer on mobile.
 * Each action is present only when its handler is given, mirroring `onUploadFile`, so the props
 * stay the single source of what the menu offers. With no actions it renders nothing.
 */
export const ChatAddMenu = ({ onUploadFile, onOpenConnections }: ChatAddMenuProps) => {
  const { t } = useLingui()
  const [open, setOpen] = useState(false)

  const uploadAction: ResponsiveActionMenuAction[] = onUploadFile
    ? [
        {
          label: t`Upload file`,
          icon: <Paperclip className="size-[var(--icon-size-sm)] text-muted-foreground" />,
          onSelect: onUploadFile,
        },
      ]
    : []
  const connectionsAction: ResponsiveActionMenuAction[] = onOpenConnections
    ? [
        {
          label: t`Connections`,
          icon: <Plug className="size-[var(--icon-size-sm)] text-muted-foreground" />,
          onSelect: onOpenConnections,
        },
      ]
    : []
  const actions = [...uploadAction, ...connectionsAction]

  if (actions.length === 0) {
    return null
  }

  return (
    <ResponsiveActionMenu
      open={open}
      onOpenChange={setOpen}
      title={t`Add to chat`}
      actions={actions}
      desktopMenu={{ side: 'bottom', align: 'start', className: 'min-w-44' }}
      trigger={
        <button
          type="button"
          aria-label={t`Add to chat`}
          title={t`Add to chat`}
          // aria-expanded covers both branches: the shared menu sets it on
          // mobile, Radix's DropdownMenuTrigger sets it on desktop.
          className="flex size-[var(--touch-height-control)] shrink-0 cursor-pointer items-center justify-center rounded-[var(--radius-control)] text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground"
        >
          <Plus className="size-[var(--icon-size-default)]" />
        </button>
      }
    />
  )
}
