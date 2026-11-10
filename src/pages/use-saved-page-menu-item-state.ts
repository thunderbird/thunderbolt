/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useRef, useState } from 'react'
import { useIsMobile } from '@/hooks/use-mobile'
import { useLongPress } from '@/hooks/use-long-press'

/** Hand menu focus to the rename input, and support the sidebar's touch long-press interaction. */
export const useSavedPageMenuItemState = (onRename: () => void) => {
  const { isMobile } = useIsMobile()
  const [menuOpen, setMenuOpen] = useState(false)
  const openingDialog = useRef(false)
  const longPressFired = useRef(false)
  const handleMenuOpenChange = (open: boolean) => {
    if (!open) {
      longPressFired.current = false
    }
    setMenuOpen(open)
  }
  const longPressHandlers = useLongPress(() => {
    if (isMobile) {
      longPressFired.current = true
      setMenuOpen(true)
    }
  })
  const startRename = () => {
    openingDialog.current = !isMobile
    onRename()
  }
  const handleCloseAutoFocus = (event: Event) => {
    if (openingDialog.current) {
      event.preventDefault()
      openingDialog.current = false
    }
  }
  return {
    isMobile,
    menuOpen,
    handleMenuOpenChange,
    longPressFired,
    longPressHandlers,
    startRename,
    handleCloseAutoFocus,
  }
}
