import { useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import type { CitationSource } from '@/types/citation'
import { SourceList } from '@/components/chat/source-list'
import { useIsMobile } from '@/hooks/use-mobile'
import { useSettings } from '@/hooks/use-settings'

type CitationBadgeProps = {
  sources: CitationSource[]
}

/**
 * CitationBadge component displays an inline citation badge that opens source details.
 *
 * Single source displays as: Source Name
 * Multiple sources displays as: Primary Source +N
 *
 * Desktop: Opens a popover anchored to the badge
 * Mobile: Opens a bottom sheet drawer
 */
export const CitationBadge = ({ sources }: CitationBadgeProps) => {
  const [isOpen, setIsOpen] = useState(false)
  const { isMobile } = useIsMobile()
  const { cloudUrl } = useSettings({ cloud_url: 'http://localhost:8000/v1' })

  if (!sources || sources.length === 0) {
    return null
  }

  const primarySource = sources.find((s) => s.isPrimary) || sources[0]
  const displayName = primarySource.siteName || primarySource.title
  const additionalCount = sources.length > 1 ? `+${sources.length - 1}` : null

  const badge = (
    <button
      onClick={() => setIsOpen(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          setIsOpen(true)
        }
      }}
      className="inline-flex max-w-48 items-center gap-1 px-2 pt-0.5 pb-1 text-xs font-normal rounded-full bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1"
      aria-label={`View source: ${primarySource.title}`}
      type="button"
    >
      <span className="truncate">{displayName}</span>
      {additionalCount && <span className="shrink-0">{additionalCount}</span>}
    </button>
  )

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
          className="inset-x-1 bottom-4 overflow-hidden rounded-2xl border p-0"
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
}
