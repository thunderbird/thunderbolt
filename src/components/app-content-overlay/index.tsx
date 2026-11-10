/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createContext, useContext, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

type AppContentOverlayContextValue = {
  container: HTMLDivElement | null
  setContainer: (element: HTMLDivElement | null) => void
}

const AppContentOverlayContext = createContext<AppContentOverlayContextValue | null>(null)

/** Shares the app's overlay surface with route content and sidebar triggers. */
export const AppContentOverlayProvider = ({ children }: { children: ReactNode }) => {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  return <AppContentOverlayContext value={{ container, setContainer }}>{children}</AppContentOverlayContext>
}

/**
 * Keeps app overlays inside the content pane beside a native browser view.
 * Layout containment gives fixed-position modal children this pane's viewport;
 * container units also cap a detail aside to the pane's available width.
 */
export const AppContentOverlayHost = ({ className }: { className?: string } = {}) => {
  const context = useContext(AppContentOverlayContext)
  return (
    <div
      ref={context?.setContainer}
      data-slot="app-content-overlay-host"
      className={cn(
        'pointer-events-none absolute inset-0 z-50 [contain:layout] [container-type:inline-size] [&>*]:pointer-events-auto',
        className,
      )}
    />
  )
}

/** Returns the bounded app portal, or the normal document portal when absent. */
export const useAppContentOverlayContainer = () => useContext(AppContentOverlayContext)?.container ?? undefined
