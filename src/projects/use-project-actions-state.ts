/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useRef, useState } from 'react'
import { useLongPress } from '@/hooks/use-long-press'
import { useIsMobile } from '@/hooks/use-mobile'
import { loadProjectArtifactsDialog } from './load-project-artifacts-dialog'

import type { ProjectActionHandlers } from './project-action-menu-items'

type ProjectActionsStateProps = ProjectActionHandlers & { onOpenArtifacts: () => void }

/** Coordinate project actions, focus restoration, and mobile long-press behavior. */
export const useProjectActionsState = ({
  onNewChat,
  onOpenArtifacts,
  onTogglePin,
  onEdit,
  onDelete,
}: ProjectActionsStateProps) => {
  const { isMobile } = useIsMobile()
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const openingDialog = useRef(false)
  const longPressFired = useRef(false)
  const handleCloseAutoFocus = (event: Event) => {
    if (openingDialog.current) {
      event.preventDefault()
      openingDialog.current = false
    }
  }
  const handleOpenChange = async (open: boolean) => {
    if (!open) {
      return
    }
    try {
      await loadProjectArtifactsDialog()
    } catch (cause) {
      console.error('[projects] Could not preload artifact gallery', cause)
    }
  }
  const handleMobileOpenChange = (open: boolean) => {
    if (!open) {
      longPressFired.current = false
    }
    setMobileMenuOpen(open)
    void handleOpenChange(open)
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
    onOpenArtifacts: () => {
      openingDialog.current = !isMobile
      onOpenArtifacts()
    },
    onTogglePin,
    onEdit: () => {
      openingDialog.current = !isMobile
      onEdit()
    },
    onDelete: () => {
      openingDialog.current = !isMobile
      onDelete()
    },
  }
  return {
    isMobile,
    mobileMenuOpen,
    longPressFired,
    longPressHandlers,
    actions,
    handleOpenChange,
    handleCloseAutoFocus,
    handleMobileOpenChange,
  }
}
