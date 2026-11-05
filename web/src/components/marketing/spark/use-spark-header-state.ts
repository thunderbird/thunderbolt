/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState } from 'react'

/** Keeps the navigation disclosure in sync with outside clicks and keyboard focus. */
export const useSparkHeaderState = () => {
  const [isOpen, setIsOpen] = useState(false)
  const navigationRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!isOpen) return

    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !navigationRef.current?.contains(event.target)) setIsOpen(false)
    }
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setIsOpen(false)
      triggerRef.current?.focus()
    }

    document.addEventListener('pointerdown', dismissOutside)
    document.addEventListener('keydown', dismissOnEscape)
    return () => {
      document.removeEventListener('pointerdown', dismissOutside)
      document.removeEventListener('keydown', dismissOnEscape)
    }
  }, [isOpen])

  return { isOpen, setIsOpen, navigationRef, triggerRef }
}
