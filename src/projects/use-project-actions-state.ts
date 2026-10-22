/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useRef, useState, useTransition } from 'react'
import { useLingui } from '@lingui/react/macro'
import { useDatabase } from '@/contexts'
import { softDeleteProject } from '@/dal/projects'
import { useLongPress } from '@/hooks/use-long-press'
import { useIsMobile } from '@/hooks/use-mobile'
import { loadProjectArtifactsDialog } from './load-project-artifacts-dialog'

type ProjectActionsStateProps = {
  projectId: string
  onNewChat: () => void
  onOpenArtifacts: () => void
  onDeleted: () => void
}

/** Coordinate project actions, focus restoration, and mobile long-press behavior. */
export const useProjectActionsState = ({
  projectId,
  onNewChat,
  onOpenArtifacts,
  onDeleted,
}: ProjectActionsStateProps) => {
  const { t } = useLingui()
  const db = useDatabase()
  const { isMobile } = useIsMobile()
  const [{ dialog, error }, setDialogState] = useState<{ dialog: 'edit' | 'delete' | null; error: string | null }>({
    dialog: null,
    error: null,
  })
  const [isPending, startTransition] = useTransition()
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const openingDialog = useRef(false)
  const longPressFired = useRef(false)
  const openDialog = (next: 'edit' | 'delete') => {
    openingDialog.current = !isMobile
    setDialogState({ dialog: next, error: null })
  }
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
    onEdit: () => openDialog('edit'),
    onDelete: () => openDialog('delete'),
  }
  return {
    isMobile,
    dialog,
    error,
    isPending,
    mobileMenuOpen,
    longPressFired,
    longPressHandlers,
    actions,
    handleOpenChange,
    handleCloseAutoFocus,
    handleMobileOpenChange,
    closeDialog: () => {
      if (!isPending) {
        setDialogState({ dialog: null, error: null })
      }
    },
    deleteProject: () => {
      startTransition(async () => {
        try {
          await softDeleteProject(db, projectId)
          setDialogState({ dialog: null, error: null })
          onDeleted()
        } catch (cause) {
          console.error('[projects] Could not delete project', cause)
          setDialogState({ dialog: 'delete', error: t`Could not delete the project. Please try again.` })
        }
      })
    },
  }
}
