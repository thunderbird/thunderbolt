/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ArtifactActions } from '@/components/artifact/artifact-actions'
import { ArtifactErrorStrip } from '@/components/artifact/artifact-error-strip'
import { SandboxedHtmlFrame } from '@/components/artifact/sandboxed-html-frame'
import { Button } from '@/components/ui/button'
import { useAppSettled } from '@/hooks/use-app-settled'
import { useOnScreen } from '@/hooks/use-on-screen'
import { cn } from '@/lib/utils'
import { AppWindow, PanelRight } from 'lucide-react'
import { useRef, useState } from 'react'

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
  // Clear a stale error only at a reload boundary (the document changed). The harness reports a
  // load-time error *before* `ready`, so clearing on `ready` would wipe an error the user never
  // saw. Adjusting state during render is the React-blessed reset-on-prop-change.
  const lastHtmlRef = useRef(html)
  if (lastHtmlRef.current !== html) {
    lastHtmlRef.current = html
    setRuntimeError(null)
  }

  // While generating the header is inert: no collapse, no hover, not focusable.
  const interactive = !streaming
  const toggle = () => setOpen((prev) => !prev)

  const titleLabel = (
    <>
      <AppWindow className="size-4 shrink-0 text-muted-foreground" />
      <span className="truncate text-sm font-medium text-muted-foreground">{title}</span>
    </>
  )

  return (
    <div ref={containerRef} className="my-2 overflow-hidden rounded-xl border border-border">
      <div
        className={cn(
          'flex h-10 items-stretch justify-between gap-2',
          // Only divide the header from the body when there is a body — otherwise (e.g. while
          // generating, before any content) this border stacks on the card's bottom border.
          open && showContent && 'border-b border-border',
        )}
      >
        {/* A real <button> owns the toggle so Enter/Space work natively and screen readers don't
            see a button nested inside a button. It fills the row (flex-1, edge-to-edge padding) so
            the whole left region is one hit target; pl-4 lines the icon up with the tool accordions.
            No fill — hover matches the tool accordions' bg-secondary; inert while streaming. */}
        {interactive ? (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 pl-4 pr-2 text-left outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            {titleLabel}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2 pl-4">{titleLabel}</div>
        )}
        {streaming ? (
          <span className="shimmer-text flex shrink-0 items-center pr-4 text-xs font-medium">Generating…</span>
        ) : (
          // The header highlights on hover, so a plain ghost hover would blend in — these buttons
          // use a stronger translucent-foreground circle that reads on top of it. pr-2 lines the
          // rightmost icon up with the tool accordion's chevron.
          <div className="flex shrink-0 items-center gap-1 pr-2">
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
                onClick={onOpenInPanel}
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
          {!streaming && runtimeError && <ArtifactErrorStrip message={runtimeError} />}
          {showContent && (
            <SandboxedHtmlFrame
              html={html}
              title={title}
              autoHeight
              allowScripts={!streaming && active}
              onError={streaming ? undefined : setRuntimeError}
            />
          )}
        </div>
      </div>
    </div>
  )
}
