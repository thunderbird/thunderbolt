import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useIsMobile } from '@/hooks/use-mobile'
import { useSettings } from '@/hooks/use-settings'
import type { CitationSource } from '@/types/citation'
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { SourceList } from './source-list'

type PopoverData = {
  citationId: number
  sources: CitationSource[]
  anchorRect: DOMRect
}

type CitationPopoverState = {
  popover: PopoverData | null
  open: (id: number, sources: CitationSource[], rect: DOMRect) => void
  close: () => void
}

const CitationPopoverContext = createContext<CitationPopoverState | null>(null)

/** Returns context value if inside a CitationPopoverProvider, or null otherwise. */
export const useCitationPopover = () => useContext(CitationPopoverContext)

/**
 * Provides citation popover state and renders the overlay (Popover/Sheet)
 * outside the markdown tree so streaming re-renders don't destroy it.
 */
export const CitationPopoverProvider = ({ children }: { children: ReactNode }) => {
  const [popover, setPopover] = useState<PopoverData | null>(null)

  const open = useCallback((id: number, sources: CitationSource[], rect: DOMRect) => {
    setPopover({ citationId: id, sources, anchorRect: rect })
  }, [])

  const close = useCallback(() => setPopover(null), [])

  const value = useMemo(() => ({ popover, open, close }), [popover, open, close])

  return (
    <CitationPopoverContext.Provider value={value}>
      {children}
      <CitationOverlay popover={popover} close={close} />
    </CitationPopoverContext.Provider>
  )
}

// --- Overlay (rendered automatically by the provider, outside the markdown tree) ---

const CitationOverlay = ({ popover, close }: { popover: PopoverData | null; close: () => void }) => {
  const { isMobile } = useIsMobile()
  const { cloudUrl } = useSettings({ cloud_url: 'http://localhost:8000/v1' })

  if (!popover) return null

  const { sources, anchorRect } = popover

  if (isMobile) {
    return (
      <Sheet open onOpenChange={(open) => !open && close()}>
        <SheetContent
          side="bottom"
          className="inset-x-1 bottom-4 overflow-hidden rounded-2xl border p-0"
          hideCloseButton
        >
          <SheetHeader className="sr-only">
            <SheetTitle>{sources.length === 1 ? 'Source' : 'Sources'}</SheetTitle>
          </SheetHeader>
          <SourceList sources={sources} proxyBase={cloudUrl.value} />
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <Popover open onOpenChange={(open) => !open && close()}>
      <PopoverAnchor asChild>
        <span
          style={{
            position: 'fixed',
            left: anchorRect.left,
            top: anchorRect.bottom,
            width: anchorRect.width,
            height: 1,
            pointerEvents: 'none',
          }}
        />
      </PopoverAnchor>
      <PopoverContent align="start" side="bottom" className="w-[420px] overflow-hidden rounded-2xl p-0">
        <SourceList sources={sources} proxyBase={cloudUrl.value} />
      </PopoverContent>
    </Popover>
  )
}
