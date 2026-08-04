/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ReactNode } from 'react'
import { createContext, lazy, Suspense, useContext, useEffect, useMemo, useRef, useState } from 'react'

import { trackEvent } from '@/lib/posthog'

// Lazy so the search subsystem (cmdk dialog, FTS, registry, icons) stays out of
// the entry bundle — the palette is only reachable via Cmd/Ctrl+K.
const SearchPalette = lazy(() =>
  import('./palette/search-palette').then((module) => ({ default: module.SearchPalette })),
)

type SearchPaletteContextValue = {
  open: () => void
}

const SearchPaletteContext = createContext<SearchPaletteContextValue>({
  open: () => {},
})

/**
 * Provides the command-palette opener, registers the Cmd/Ctrl+K global
 * shortcut, and lazily mounts the palette modal on first open.
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

  // Mount the lazy modal on first open and keep it mounted thereafter so its
  // open/close transition animates on later toggles.
  const hasOpenedRef = useRef(false)
  if (isOpen) {
    hasOpenedRef.current = true
  }

  const value = useMemo<SearchPaletteContextValue>(() => ({ open: () => setIsOpen(true) }), [])

  return (
    <SearchPaletteContext.Provider value={value}>
      {children}
      {hasOpenedRef.current ? (
        <Suspense fallback={null}>
          <SearchPalette open={isOpen} onOpenChange={setIsOpen} />
        </Suspense>
      ) : null}
    </SearchPaletteContext.Provider>
  )
}

/** Access the command-palette controls. */
export const useSearchPalette = () => useContext(SearchPaletteContext)
