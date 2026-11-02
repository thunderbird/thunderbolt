/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useRef, useState } from 'react'
import { useLongPress } from '@/hooks/use-long-press'
import { useIsMobile } from '@/hooks/use-mobile'

import type { ProjectActionHandlers } from './project-action-menu-items'

/** Keep menu focus and mobile long-press behavior independent of dialog ownership. */
export const useProjectActionsState = (actions: ProjectActionHandlers) => {
  const { isMobile } = useIsMobile()
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const openingDialog = useRef(false)
  const longPressFired = useRef(false)
  const handOffFocus = (action: () => void) => () => {
    openingDialog.current = !isMobile
    action()
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
  return {
    isMobile,
    mobileMenuOpen,
    longPressFired,
    longPressHandlers,
    actions: {
      ...actions,
      onNewChat: handOffFocus(actions.onNewChat),
      onEdit: handOffFocus(actions.onEdit),
      onDelete: handOffFocus(actions.onDelete),
    },
    handleCloseAutoFocus,
    handleMobileOpenChange,
  }
}
