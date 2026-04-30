/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useIsMobile } from '@/hooks/use-mobile'
import type { CitationSource } from '@/types/citation'
import { memo, useState } from 'react'
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

  if (ctx && citationId !== undefined) {
    return <ManagedBadge sources={sources} citationId={citationId} />
  }

  return <StandaloneBadge sources={sources} />
})

CitationBadge.displayName = 'CitationBadge'

const badgeClass =
  'inline-flex max-w-48 items-center gap-1 px-2 pt-0.5 pb-1 text-xs font-normal rounded-full bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1'

const getBadgeLabel = (sources: CitationSource[]) => {
  const primary = sources.find((s) => s.isPrimary) || sources[0]
  return {
    displayName: primary.siteName || primary.title,
    additionalCount: sources.length > 1 ? `+${sources.length - 1}` : null,
    ariaLabel: `View source: ${primary.siteName || primary.title}`,
  }
}

// --- Context-managed variant (inline in streaming markdown) ---

const ManagedBadge = memo(({ sources, citationId }: { sources: CitationSource[]; citationId: number }) => {
  const ctx = useCitationPopover()!
  const isOpen = ctx.popover?.citationId === citationId
  const { displayName, additionalCount, ariaLabel } = getBadgeLabel(sources)

  const toggle = (element: HTMLElement) => {
    if (isOpen) {
      ctx.close()
    } else {
      ctx.open(citationId, sources, element)
    }
  }

  return (
    <button
      onClick={(e) => toggle(e.currentTarget)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          toggle(e.currentTarget)
        }
      }}
      className={badgeClass}
      aria-label={ariaLabel}
      aria-expanded={isOpen}
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
  const { displayName, additionalCount, ariaLabel } = getBadgeLabel(sources)

  const badge = (
    <button
      onClick={() => setIsOpen(!isOpen)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          setIsOpen(!isOpen)
        }
      }}
      className={badgeClass}
      aria-label={ariaLabel}
      aria-expanded={isOpen}
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
          <SourceList sources={sources} />
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
          <SourceList sources={sources} />
        </SheetContent>
      </Sheet>
    </>
  )
})

StandaloneBadge.displayName = 'StandaloneBadge'
