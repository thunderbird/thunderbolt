/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ReactNode } from 'react'
import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

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

  // Mirror open state into a ref so the keydown toggle and imperative opener read
  // it synchronously, and so a `search_palette_open` fires only on the closed→open
  // transition — analytics belongs in the handler that opens the palette, not an
  // effect keyed on `isOpen`.
  const isOpenRef = useRef(isOpen)
  isOpenRef.current = isOpen

  const setOpen = useCallback((next: boolean) => {
    if (next && !isOpenRef.current) {
      trackEvent('search_palette_open')
    }
    setIsOpen(next)
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setOpen(!isOpenRef.current)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [setOpen])

  // Mount the lazy modal on first open and keep it mounted thereafter so its
  // open/close transition animates on later toggles.
  const hasOpenedRef = useRef(false)
  if (isOpen) {
    hasOpenedRef.current = true
  }

  const value = useMemo<SearchPaletteContextValue>(() => ({ open: () => setOpen(true) }), [setOpen])

  return (
    <SearchPaletteContext.Provider value={value}>
      {children}
      {hasOpenedRef.current ? (
        <Suspense fallback={null}>
          <SearchPalette open={isOpen} onOpenChange={setOpen} />
        </Suspense>
      ) : null}
    </SearchPaletteContext.Provider>
  )
}

/** Access the command-palette controls. */
export const useSearchPalette = () => useContext(SearchPaletteContext)
