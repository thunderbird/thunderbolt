import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useIsMobile } from '@/hooks/use-mobile'
import { useSettings } from '@/hooks/use-settings'
import type { CitationSource } from '@/types/citation'
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { SourceList } from './source-list'

type CitationPopoverState = {
  openCitationId: number | null
  openSources: CitationSource[] | null
  anchorRect: DOMRect | null
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
  const [state, setState] = useState<{
    id: number | null
    sources: CitationSource[] | null
    rect: DOMRect | null
  }>({ id: null, sources: null, rect: null })

  const open = useCallback((id: number, sources: CitationSource[], rect: DOMRect) => {
    setState({ id, sources, rect })
  }, [])

  const close = useCallback(() => {
    setState({ id: null, sources: null, rect: null })
  }, [])

  const value = useMemo(
    () => ({
      openCitationId: state.id,
      openSources: state.sources,
      anchorRect: state.rect,
      open,
      close,
    }),
    [state, open, close],
  )

  return (
    <CitationPopoverContext.Provider value={value}>
      {children}
      <CitationOverlay sources={state.sources} anchorRect={state.rect} close={close} />
    </CitationPopoverContext.Provider>
  )
}

// --- Overlay (rendered automatically by the provider, outside the markdown tree) ---

const CitationOverlay = ({
  sources,
  anchorRect,
  close,
}: {
  sources: CitationSource[] | null
  anchorRect: DOMRect | null
  close: () => void
}) => {
  const { isMobile } = useIsMobile()
  const { cloudUrl } = useSettings({ cloud_url: 'http://localhost:8000/v1' })

  if (!sources || !anchorRect) return null

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
