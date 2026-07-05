/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ArtifactActions } from '@/components/artifact/artifact-actions'
import { SandboxedHtmlFrame } from '@/components/artifact/sandboxed-html-frame'
import { Button } from '@/components/ui/button'
import { useAppSettled } from '@/hooks/use-app-settled'
import { useOnScreen } from '@/hooks/use-on-screen'
import { cn } from '@/lib/utils'
import { AlertTriangle, AppWindow, PanelRight } from 'lucide-react'
import { useRef, useState, type KeyboardEvent } from 'react'

/**
 * Whether the (possibly partial) HTML has anything renderable in `<body>` yet.
 * Used to avoid showing a blank frame while only the `<head>`/CSS is streaming.
 */
const hasRenderableBody = (html: string): boolean => {
  if (!html.trim()) {
    return false
  }
  const body = new DOMParser().parseFromString(html, 'text/html').body
  return !!body && (body.children.length > 0 || (body.textContent ?? '').trim().length > 0)
}

type InlineArtifactCardProps = {
  html: string
  title: string
  /** While true, render a live scripts-off preview of the (partial) HTML as it streams in. */
  streaming?: boolean
  /** Opens the artifact in the side panel; omitted while streaming or when no panel is available. */
  onOpenInPanel?: () => void
}

/**
 * A verified HTML artifact rendered inline in the chat transcript as its own
 * card. It shows the page background like the tool accordions (same hover), set
 * apart only by a permanent border and a divided header. The whole header is one hit target:
 * it collapses the card on click and highlights on hover across its full width,
 * with no chevron. It's open by default with ephemeral collapse state. While
 * streaming the header is inert (no toggle, no hover) and shows a shimmering
 * "Generating…"; no blank frame appears until the body has content. Once done
 * the iframe auto-sizes to its content (so a tall artifact grows the card rather
 * than scrolling inside it) and runtime errors surface as a strip.
 */
export const InlineArtifactCard = ({ html, title, streaming = false, onOpenInPanel }: InlineArtifactCardProps) => {
  const [open, setOpen] = useState(true)
  const [runtimeError, setRuntimeError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const settled = useAppSettled()
  const onScreen = useOnScreen(containerRef)
  // Run the artifact's scripts only once the app has settled after its initial load AND it's on screen.
  const active = settled && onScreen
  // Latch once the body has content (or streaming ends) so we don't re-parse the growing
  // HTML with DOMParser on every streamed token — once shown, it stays shown.
  const shownRef = useRef(false)
  if (!shownRef.current && (!streaming || hasRenderableBody(html))) {
    shownRef.current = true
  }
  const showContent = shownRef.current

  // While generating the header is inert: no collapse, no hover, not focusable.
  const interactive = !streaming
  const toggle = () => setOpen((prev) => !prev)
  const onHeaderKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Only the header itself toggles — not Enter/Space on a focused action button inside it.
    if (event.target !== event.currentTarget) {
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      toggle()
    }
  }

  return (
    <div ref={containerRef} className="my-2 overflow-hidden rounded-xl border border-border">
      <div
        role={interactive ? 'button' : undefined}
        tabIndex={interactive ? 0 : undefined}
        aria-expanded={interactive ? open : undefined}
        onClick={interactive ? toggle : undefined}
        onKeyDown={interactive ? onHeaderKeyDown : undefined}
        className={cn(
          // px-4 matches the tool accordion trigger so the icon + title line up with tool calls.
          'flex h-10 items-center justify-between gap-2 px-4 outline-none transition-colors',
          // Only divide the header from the body when there is a body — otherwise (e.g. while
          // generating, before any content) this border stacks on the card's bottom border.
          open && showContent && 'border-b border-border',
          // No fill — the card shows the page background like the tool accordions do, set apart
          // only by its border; the header hover matches the tool accordions' bg-secondary.
          interactive && 'cursor-pointer hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <AppWindow className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium text-muted-foreground">{title}</span>
        </div>
        {streaming ? (
          <span className="shimmer-text shrink-0 text-xs font-medium">Generating…</span>
        ) : (
          // The header itself highlights on hover, so a plain ghost hover would blend in — these
          // buttons use a stronger translucent-foreground circle that reads on top of it.
          // -mr-2 pulls the rightmost icon button out so its icon lines up with the tool
          // accordion's chevron (a 32px button at px-4 would otherwise sit ~8px further in).
          <div className="-mr-2 flex shrink-0 items-center gap-1">
            <ArtifactActions
              html={html}
              title={title}
              buttonClassName="text-muted-foreground hover:bg-foreground/10 dark:hover:bg-foreground/20"
            />
            {onOpenInPanel && (
              <Button
                variant="ghost"
                size="icon"
                className="size-8 shrink-0 rounded-full text-muted-foreground hover:bg-foreground/10 dark:hover:bg-foreground/20"
                title="Open in side panel"
                onClick={(event) => {
                  event.stopPropagation()
                  onOpenInPanel()
                }}
              >
                <PanelRight className="size-4" />
              </Button>
            )}
          </div>
        )}
      </div>
      <div
        className={cn(
          'grid transition-[grid-template-rows] duration-200 ease-out',
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        )}
      >
        {/* min-h-0 lets the row collapse to exactly 0 — without it the grid leaves a ~1px
            sliver of the frame above the card's bottom border when closed. */}
        <div className="min-h-0 overflow-hidden">
          {!streaming && runtimeError && (
            <div className="flex items-center gap-2 border-b border-border bg-destructive/10 px-4 py-1.5 text-xs text-destructive">
              <AlertTriangle className="size-3.5 shrink-0" />
              <span className="truncate">{runtimeError}</span>
            </div>
          )}
          {showContent && (
            <SandboxedHtmlFrame
              html={html}
              title={title}
              autoHeight
              allowScripts={!streaming && active}
              onReady={() => setRuntimeError(null)}
              onError={streaming ? undefined : setRuntimeError}
            />
          )}
        </div>
      </div>
    </div>
  )
}
