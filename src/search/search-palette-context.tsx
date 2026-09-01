/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ComponentType, ReactNode } from 'react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

import { trackEvent } from '@/lib/posthog'
import { loadSearchPalette } from './palette/search-palette-loader'

type PaletteComponent = ComponentType<{ open: boolean; onOpenChange: (open: boolean) => void }>

type SearchPaletteContextValue = {
  open: () => void
}

const SearchPaletteContext = createContext<SearchPaletteContextValue>({
  open: () => {},
})

/**
 * Provides the command-palette opener, registers the Cmd/Ctrl+K global
 * shortcut, and mounts the palette modal once its chunk has loaded.
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

  /**
   * The palette component, held in state rather than reached through
   * `React.lazy` + `Suspense`.
   *
   * `lazy` only starts its factory when it first renders, so it suspends on that
   * render even when the module is already in memory. React commits the fallback,
   * and from then on the boundary is governed by the reveal throttle it uses to
   * stop fallbacks flashing — so the content is withheld for ~300ms after the
   * promise has already resolved. Profiling the first Cmd+K showed exactly that:
   * a `setTimeout(289ms)` scheduled by react-dom's `performWorkOnRoot`, an
   * entirely idle main thread across it, then the dialog mounting (THU-846).
   *
   * Resolving it ourselves means no boundary, no fallback, and nothing to
   * throttle. The root kicks the same import off during boot, so by the time
   * anyone presses Cmd+K this is already set and opening is a state toggle.
   */
  const [Palette, setPalette] = useState<PaletteComponent | null>(null)

  useEffect(() => {
    let cancelled = false
    void loadSearchPalette().then((module) => {
      // Set via updater — a component *is* a function, so passing it directly
      // would have React call it as a lazy initializer.
      if (!cancelled) {
        setPalette(() => module.SearchPalette)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  const value = useMemo<SearchPaletteContextValue>(() => ({ open: () => setOpen(true) }), [setOpen])

  return (
    <SearchPaletteContext.Provider value={value}>
      {children}
      {/* Mounted closed once loaded, so the first open costs the same as every
          one after it. Radix renders nothing for a closed dialog. */}
      {Palette ? <Palette open={isOpen} onOpenChange={setOpen} /> : null}
    </SearchPaletteContext.Provider>
  )
}

/** Access the command-palette controls. */
export const useSearchPalette = () => useContext(SearchPaletteContext)
