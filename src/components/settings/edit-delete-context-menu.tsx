/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { SquarePen, Trash2 } from 'lucide-react'

import { ContextMenuContent, ContextMenuItem } from '@/components/ui/context-menu'

/** Shared right-click Edit/Delete menu for settings list rows. */
export const EditDeleteContextMenuContent = ({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) => (
  <ContextMenuContent className="min-w-56">
    <ContextMenuItem onClick={onEdit} className="cursor-pointer">
      <SquarePen className="size-4 mr-2" />
      Edit
    </ContextMenuItem>
    <ContextMenuItem onClick={onDelete} className="cursor-pointer">
      <Trash2 className="size-4 mr-2" />
      Delete
    </ContextMenuItem>
  </ContextMenuContent>
)
