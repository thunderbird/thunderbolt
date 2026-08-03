/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ReactNode } from 'react'
import { createContext, useContext, useEffect, useMemo, useState } from 'react'

import { trackEvent } from '@/lib/posthog'
import { SearchPalette } from './palette/search-palette'

type SearchPaletteContextValue = {
  open: () => void
  close: () => void
  isOpen: boolean
}

const SearchPaletteContext = createContext<SearchPaletteContextValue>({
  open: () => {},
  close: () => {},
  isOpen: false,
})

/**
 * Provides command-palette open/close state, registers the Cmd/Ctrl+K global
 * shortcut, and renders the palette modal alongside the app.
 */
export const SearchPaletteProvider = ({ children }: { children: ReactNode }) => {
  const [isOpen, setIsOpen] = useState(false)

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setIsOpen((prev) => !prev)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  useEffect(() => {
    if (isOpen) {
      trackEvent('search_palette_open')
    }
  }, [isOpen])

  const value = useMemo<SearchPaletteContextValue>(
    () => ({ open: () => setIsOpen(true), close: () => setIsOpen(false), isOpen }),
    [isOpen],
  )

  return (
    <SearchPaletteContext.Provider value={value}>
      {children}
      <SearchPalette open={isOpen} onOpenChange={setIsOpen} />
    </SearchPaletteContext.Provider>
  )
}

/** Access the command-palette controls. */
export const useSearchPalette = () => useContext(SearchPaletteContext)
