import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { defaultCloudUrlValue } from '@/defaults/settings'
import { useIsMobile } from '@/hooks/use-mobile'
import { useSettings } from '@/hooks/use-settings'
import type { CitationSource } from '@/types/citation'
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { SourceList } from './source-list'

type PopoverData = {
  citationId: number
  sources: CitationSource[]
  anchorElement: HTMLElement
}

type CitationPopoverState = {
  popover: PopoverData | null
  open: (id: number, sources: CitationSource[], element: HTMLElement) => void
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

  const open = useCallback((id: number, sources: CitationSource[], element: HTMLElement) => {
    setPopover({ citationId: id, sources, anchorElement: element })
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

const CitationOverlay = memo(({ popover, close }: { popover: PopoverData | null; close: () => void }) => {
  const { isMobile } = useIsMobile()
  const { cloudUrl } = useSettings({ cloud_url: defaultCloudUrlValue })
  const anchorRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!popover) {
      return
    }
    const { anchorElement } = popover
    const anchorSpan = anchorRef.current
    if (!anchorSpan) {
      return
    }

    const rect = anchorElement.getBoundingClientRect()
    anchorSpan.style.left = `${rect.left}px`
    anchorSpan.style.top = `${rect.bottom}px`
    anchorSpan.style.width = `${rect.width}px`

    const handler = () => close()
    window.addEventListener('scroll', handler, { capture: true })
    return () => window.removeEventListener('scroll', handler, { capture: true })
  }, [popover, close])

  if (!popover) {
    return null
  }

  const { sources } = popover

  if (isMobile) {
    return (
      <Sheet open onOpenChange={(open) => !open && close()}>
        <SheetContent
          side="bottom"
          className="inset-x-1 overflow-hidden rounded-2xl border p-0"
          style={{ bottom: 'calc(20px + var(--safe-area-bottom-padding, 0px))' }}
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
          ref={anchorRef}
          style={{
            position: 'fixed',
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
})

CitationOverlay.displayName = 'CitationOverlay'
