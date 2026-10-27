/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useRef, useState, useTransition } from 'react'
import { useDatabase } from '@/contexts'
import { setProjectPinned } from '@/dal/projects'
import { useLongPress } from '@/hooks/use-long-press'
import { useIsMobile } from '@/hooks/use-mobile'

type ProjectActionsStateProps = {
  projectId: string
  pinned: boolean
  onNewChat: () => void
}

/** Coordinate project actions, focus restoration, and mobile long-press behavior. */
export const useProjectActionsState = ({ projectId, pinned, onNewChat }: ProjectActionsStateProps) => {
  const db = useDatabase()
  const { isMobile } = useIsMobile()
  const [dialog, setDialog] = useState<'edit' | 'delete' | null>(null)
  const [, startTransition] = useTransition()
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const openingDialog = useRef(false)
  const longPressFired = useRef(false)
  const openDialog = (next: 'edit' | 'delete') => {
    openingDialog.current = !isMobile
    setDialog(next)
  }
  const handleCloseAutoFocus = (event: Event) => {
    if (openingDialog.current) {
      event.preventDefault()
      openingDialog.current = false
    }
  }
  const handleMobileOpenChange = (open: boolean) => {
    if (!open) {
      longPressFired.current = false
    }
    setMobileMenuOpen(open)
  }
  const longPressHandlers = useLongPress(() => {
    longPressFired.current = true
    handleMobileOpenChange(true)
  })
  const actions = {
    onNewChat: () => {
      openingDialog.current = !isMobile
      onNewChat()
    },
    onTogglePin: () => {
      startTransition(async () => {
        await setProjectPinned(db, projectId, pinned ? null : 0)
      })
    },
    onEdit: () => openDialog('edit'),
    onDelete: () => openDialog('delete'),
  }
  return {
    isMobile,
    dialog,
    mobileMenuOpen,
    longPressFired,
    longPressHandlers,
    actions,
    handleCloseAutoFocus,
    handleMobileOpenChange,
    closeDialog: () => setDialog(null),
  }
}
