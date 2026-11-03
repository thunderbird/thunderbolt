/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { MessageCirclePlus, Pin, PinOff, SquarePen, Trash2 } from 'lucide-react'
import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'

export type ProjectActionHandlers = {
  onNewChat: () => void
  onEdit: () => void
  onTogglePin: () => void
  onDelete: () => void
}

/** Keep the folder's context menu and overflow menu in sync. */
export const ProjectActionMenuItems = ({
  context = false,
  onNewChat,
  onEdit,
  onTogglePin,
  pinned,
  onDelete,
}: ProjectActionHandlers & { context?: boolean; pinned: boolean }) => {
  const Item = context ? ContextMenuItem : DropdownMenuItem
  const Separator = context ? ContextMenuSeparator : DropdownMenuSeparator
  return (
    <>
      <Item onSelect={onNewChat} className="cursor-pointer">
        <MessageCirclePlus />
        <Trans>New chat</Trans>
      </Item>
      <Item onSelect={onTogglePin} className="cursor-pointer">
        {pinned ? <PinOff /> : <Pin />}
        {pinned ? <Trans>Unpin</Trans> : <Trans>Pin</Trans>}
      </Item>
      <Separator />
      <Item onSelect={onEdit} className="cursor-pointer">
        <SquarePen />
        <Trans>Edit</Trans>
      </Item>
      <Item onSelect={onDelete} className="cursor-pointer">
        <Trash2 />
        <Trans>Delete</Trans>
      </Item>
    </>
  )
}
