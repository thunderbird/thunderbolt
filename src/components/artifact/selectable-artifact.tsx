/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ArtifactSelectionItem, ArtifactTextSelection } from '@/artifacts/harness'
import { SandboxedHtmlFrame } from '@/components/artifact/sandboxed-html-frame'
import { MarqueeOverlay } from '@/components/embedded/marquee-overlay'
import { SelectionPopover } from '@/components/embedded/selection-popover'
import type { SurfaceRect } from '@/components/embedded/types'
import { Button } from '@/components/ui/button'
import { MousePointerSquareDashed } from 'lucide-react'
import { useCallback, useReducer, useRef, useState } from 'react'

/**
 * An artifact you can point at.
 *
 * Same two gestures a Mini App has — highlight text for "Ask about this", or
 * drag a box over several things at once — reusing the very same overlay and
 * popover. A user who learns the gesture on one surface should find it on the
 * other; that they're sandboxed completely differently underneath is not
 * something they should ever have to know.
 *
 * The artifact contributes only answers: it reports highlights and resolves a
 * rect to content. Thunderbolt owns the dim layer, the box, the confirm step
 * and the chips, exactly as it does for Mini Apps.
 */

type Mode =
  | { kind: 'idle' }
  | { kind: 'drawing' }
  /** The guest answered; an empty array is a real answer ("nothing there"). */
  | { kind: 'reviewing'; items: ArtifactSelectionItem[] }

type Action =
  | { type: 'marqueeStarted' }
  | { type: 'marqueeAnswered'; items: ArtifactSelectionItem[] }
  | { type: 'dismissed' }

/**
 * One state machine rather than a boolean plus a nullable array, so "drawing"
 * and "reviewing" can't both be true — the pair of flags this replaces allowed
 * a result bar to sit pinned over an active marquee.
 */
const modeReducer = (_mode: Mode, action: Action): Mode => {
  switch (action.type) {
    case 'marqueeStarted':
      return { kind: 'drawing' }
    case 'marqueeAnswered':
      return { kind: 'reviewing', items: action.items }
    case 'dismissed':
      return { kind: 'idle' }
  }
}

export type SelectableArtifactProps = {
  html: string
  title: string
  autoHeight?: boolean
  allowScripts?: boolean
  onError?: (error: string) => void
  /** Attach the chosen passages to the composer as quote chips. */
  onAsk: (passages: string[]) => void
}

export const SelectableArtifact = ({
  html,
  title,
  autoHeight,
  allowScripts,
  onError,
  onAsk,
}: SelectableArtifactProps) => {
  const [mode, dispatch] = useReducer(modeReducer, { kind: 'idle' })
  const [selection, setSelection] = useState<ArtifactTextSelection | null>(null)

  // The resolver is held in a ref, not state: it changes only when the document
  // reloads, and storing it in state would re-render on every handshake.
  const queryRef = useRef<((rect: SurfaceRect) => Promise<ArtifactSelectionItem[]>) | null>(null)
  const handleQueryReady = useCallback((query: (rect: SurfaceRect) => Promise<ArtifactSelectionItem[]>) => {
    queryRef.current = query
  }, [])

  const handleMarquee = useCallback(async (rect: SurfaceRect) => {
    dispatch({ type: 'marqueeAnswered', items: (await queryRef.current?.(rect)) ?? [] })
  }, [])

  const askAboutSelection = () => {
    if (selection) {
      onAsk([selection.text])
      setSelection(null)
    }
  }

  const askAboutItems = (items: ArtifactSelectionItem[]) => {
    onAsk(items.map((item) => `${item.label}\n${item.text}`))
    dispatch({ type: 'dismissed' })
  }

  return (
    <div className="relative">
      <SandboxedHtmlFrame
        html={html}
        title={title}
        autoHeight={autoHeight}
        allowScripts={allowScripts}
        onError={onError}
        onSelectionChange={setSelection}
        onQueryReady={handleQueryReady}
      />

      {mode.kind === 'idle' && selection?.rect && <SelectionPopover rect={selection.rect} onAsk={askAboutSelection} />}

      {mode.kind === 'drawing' && (
        <MarqueeOverlay onSelect={handleMarquee} onCancel={() => dispatch({ type: 'dismissed' })} />
      )}

      {mode.kind === 'reviewing' && (
        <div className="absolute inset-x-0 bottom-0 z-30 flex items-center justify-center gap-3 border-t bg-background/95 px-4 py-3 backdrop-blur">
          <span className="text-[length:var(--font-size-sm)] text-muted-foreground">
            {mode.items.length === 0
              ? 'Nothing selectable in that area'
              : `${mode.items.length} item${mode.items.length === 1 ? '' : 's'} selected`}
          </span>
          {mode.items.length > 0 && (
            <Button size="sm" onClick={() => askAboutItems(mode.items)}>
              Ask about {mode.items.length === 1 ? 'it' : 'them'}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => dispatch(mode.items.length === 0 ? { type: 'marqueeStarted' } : { type: 'dismissed' })}
          >
            {mode.items.length === 0 ? 'Try again' : 'Cancel'}
          </Button>
        </div>
      )}

      {mode.kind === 'idle' && !selection && (
        <Button
          onClick={() => dispatch({ type: 'marqueeStarted' })}
          variant="secondary"
          size="sm"
          className="absolute bottom-3 right-3 z-10 rounded-full shadow-lg"
        >
          <MousePointerSquareDashed className="size-[var(--icon-size-sm)]" />
          Select
        </Button>
      )}
    </div>
  )
}
