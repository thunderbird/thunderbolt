/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { useLongPress } from '@/hooks/use-long-press'

/** Keep a section's disclosure tap separate from its long-press action menu. */
export const useSidebarSectionToggleState = (onToggle: () => void) => {
  const [menuOpen, setOpen] = useState(false)
  const longPressFired = useRef(false)
  const setMenuOpen = (open: boolean) => {
    if (!open) {
      longPressFired.current = false
    }
    setOpen(open)
  }
  const longPressHandlers = useLongPress(() => {
    longPressFired.current = true
    setMenuOpen(true)
  })

  return {
    menuOpen,
    setMenuOpen,
    longPressHandlers,
    handleClick: (event: MouseEvent<HTMLButtonElement>) => {
      if (longPressFired.current || menuOpen) {
        longPressFired.current = false
        event.preventDefault()
        event.stopPropagation()
        return
      }
      onToggle()
    },
    handleKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault()
        setMenuOpen(true)
      }
    },
  }
}
