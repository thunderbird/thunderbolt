import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useContentView } from '@/content-view/context'
import { useIsMobile } from '@/hooks/use-mobile'
import { useSettings } from '@/hooks/use-settings'
import { type CitationSource, buildDocumentSideviewId } from '@/types/citation'
import { type MouseEvent, memo, useCallback, useState } from 'react'
import { useCitationPopover } from './citation-popover'
import { SourceList } from './source-list'

type CitationBadgeProps = {
  sources: CitationSource[]
  citationId?: number
}

/**
 * When inside a CitationPopoverProvider, acts as a lightweight trigger (overlay rendered externally).
 * When standalone (block-level widget), owns its own Popover/Sheet.
 * Memoized to prevent unnecessary re-renders during streaming.
 */
export const CitationBadge = memo(({ sources, citationId }: CitationBadgeProps) => {
  const ctx = useCitationPopover()

  if (!sources || sources.length === 0) {
    return null
  }

  const primary = sources.find((s) => s.isPrimary) || sources[0]
  if (primary.isLoading) {
    return <LoadingBadge />
  }

  if (ctx && citationId !== undefined) {
    return <ManagedBadge sources={sources} citationId={citationId} />
  }

  return <StandaloneBadge sources={sources} />
})

CitationBadge.displayName = 'CitationBadge'

const badgeClass =
  'inline-flex max-w-48 items-center gap-1 px-2 pt-0.5 pb-1 text-xs font-normal rounded-full bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1'

const loadingBadgeClass =
  'inline-flex items-center justify-center gap-[3px] px-2 pt-0.5 pb-1 text-xs rounded-full bg-muted cursor-default leading-none'

const LoadingBadge = memo(() => (
  <span className={loadingBadgeClass} aria-label="Loading citation">
    {/* Zero-width space gives the badge the same text-line height as regular badges */}
    <span className="w-0 overflow-hidden">{'\u200B'}</span>
    <span className="size-[3.5px] rounded-full bg-muted-foreground/60 animate-[typing-bounce_1.4s_ease-in-out_infinite]" />
    <span className="size-[3.5px] rounded-full bg-muted-foreground/60 animate-[typing-bounce_1.4s_ease-in-out_0.2s_infinite]" />
    <span className="size-[3.5px] rounded-full bg-muted-foreground/60 animate-[typing-bounce_1.4s_ease-in-out_0.4s_infinite]" />
  </span>
))

LoadingBadge.displayName = 'LoadingBadge'

const getBadgeLabel = (sources: CitationSource[]) => {
  const primary = sources.find((s) => s.isPrimary) || sources[0]
  const label = primary.documentMeta ? primary.title : primary.siteName || primary.title
  return {
    displayName: label,
    additionalCount: sources.length > 1 ? `+${sources.length - 1}` : null,
    ariaLabel: primary.documentMeta ? `Open document: ${label}` : `View source: ${label}`,
  }
}

/** True when there's exactly one source and it's a document (click → open sideview directly) */
const isSingleDocumentCitation = (sources: CitationSource[]) => {
  return sources.length === 1 && !!sources[0]?.documentMeta
}

// --- Context-managed variant (inline in streaming markdown) ---

const ManagedBadge = memo(({ sources, citationId }: { sources: CitationSource[]; citationId: number }) => {
  const ctx = useCitationPopover()!
  const { showSideview } = useContentView()
  const isOpen = ctx.popover?.citationId === citationId
  const { displayName, additionalCount, ariaLabel } = getBadgeLabel(sources)
  const isSingleDoc = isSingleDocumentCitation(sources)

  const openDocumentSideview = useCallback(() => {
    showSideview('document', buildDocumentSideviewId(sources[0].documentMeta!))
  }, [sources, showSideview])

  const toggle = (rect: DOMRect) => {
    if (isOpen) {
      ctx.close()
    } else {
      ctx.open(citationId, sources, rect)
    }
  }

  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    if (isSingleDoc) {
      openDocumentSideview()
      return
    }
    toggle(e.currentTarget.getBoundingClientRect())
  }

  return (
    <button
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          if (isSingleDoc) {
            openDocumentSideview()
          } else {
            toggle(e.currentTarget.getBoundingClientRect())
          }
        }
      }}
      className={badgeClass}
      aria-label={ariaLabel}
      aria-expanded={isSingleDoc ? undefined : isOpen}
      type="button"
    >
      <span className="truncate">{displayName}</span>
      {additionalCount && <span className="shrink-0">{additionalCount}</span>}
    </button>
  )
})

ManagedBadge.displayName = 'ManagedBadge'

// --- Standalone variant (block-level widget, no streaming concerns) ---

const StandaloneBadge = memo(({ sources }: { sources: CitationSource[] }) => {
  const [isOpen, setIsOpen] = useState(false)
  const { isMobile } = useIsMobile()
  const { cloudUrl } = useSettings({ cloud_url: 'http://localhost:8000/v1' })
  const { showSideview } = useContentView()
  const { displayName, additionalCount, ariaLabel } = getBadgeLabel(sources)
  const isSingleDoc = isSingleDocumentCitation(sources)

  const openDocumentSideview = useCallback(() => {
    showSideview('document', buildDocumentSideviewId(sources[0].documentMeta!))
  }, [sources, showSideview])

  const handleClick = () => {
    if (isSingleDoc) {
      openDocumentSideview()
      return
    }
    setIsOpen(!isOpen)
  }

  const badge = (
    <button
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          if (isSingleDoc) {
            openDocumentSideview()
          } else {
            setIsOpen(!isOpen)
          }
        }
      }}
      className={badgeClass}
      aria-label={ariaLabel}
      aria-expanded={isSingleDoc ? undefined : isOpen}
      type="button"
    >
      <span className="truncate">{displayName}</span>
      {additionalCount && <span className="shrink-0">{additionalCount}</span>}
    </button>
  )

  if (isSingleDoc) {
    return badge
  }

  if (!isMobile) {
    return (
      <Popover open={isOpen} onOpenChange={setIsOpen}>
        <PopoverTrigger asChild>{badge}</PopoverTrigger>
        <PopoverContent align="start" side="bottom" className="w-[420px] overflow-hidden rounded-2xl p-0">
          <SourceList sources={sources} proxyBase={cloudUrl.value} />
        </PopoverContent>
      </Popover>
    )
  }

  return (
    <>
      {badge}
      <Sheet open={isOpen} onOpenChange={setIsOpen}>
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
    </>
  )
})

StandaloneBadge.displayName = 'StandaloneBadge'
