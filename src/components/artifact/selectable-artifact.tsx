/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import type { ArtifactContext, ArtifactSelectionItem, ArtifactTextSelection } from '@/artifacts/harness'
import { SandboxedHtmlFrame } from '@/components/artifact/sandboxed-html-frame'
import { cn } from '@/lib/utils'
import { MarqueeOverlay } from '@/components/embedded/marquee-overlay'
import { SurfaceSelectionBar } from '@/components/embedded/surface-selection-bar'
import { useSurfaceSelection } from '@/components/embedded/use-surface-selection'
import { SelectionPopover } from '@/components/embedded/selection-popover'
import type { SurfaceRect } from '@/components/embedded/types'
import { Button } from '@/components/ui/button'
import { MousePointerSquareDashed } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'

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

export type SelectableArtifactProps = {
  html: string
  title: string
  autoHeight?: boolean
  allowScripts?: boolean
  onError?: (error: string) => void
  /** Attach the chosen passages to the composer as quote chips. */
  onAsk: (passages: string[]) => void
  onContextChange?: (context: ArtifactContext) => void
}

export const SelectableArtifact = ({
  html,
  title,
  autoHeight,
  allowScripts,
  onError,
  onAsk,
  onContextChange,
}: SelectableArtifactProps) => {
  const [selection, setSelection] = useState<ArtifactTextSelection | null>(null)

  // The resolver is held in a ref, not state: it changes only when the document
  // reloads, and storing it in state would re-render on every handshake.
  const queryRef = useRef<((rect: SurfaceRect) => Promise<ArtifactSelectionItem[]>) | null>(null)
  const handleQueryReady = useCallback((query: (rect: SurfaceRect) => Promise<ArtifactSelectionItem[]>) => {
    queryRef.current = query
  }, [])

  const query = useCallback(async (rect: SurfaceRect) => (await queryRef.current?.(rect)) ?? [], [])

  const { mode, startMarquee, dismiss, resolveMarquee, askAboutItems } = useSurfaceSelection({ query, onAsk })

  const askAboutSelection = () => {
    if (selection) {
      onAsk([selection.text])
      setSelection(null)
    }
  }

  return (
    /*
     * `h-full` unless the frame is sizing itself to its content. This wrapper
     * sits between the panel's `flex-1` container and the iframe's own
     * `h-full`, so leaving it auto-height broke the percentage chain and the
     * artifact rendered at the iframe's intrinsic default — visibly clipped in
     * the side panel. When `autoHeight` is set the opposite is true: the
     * wrapper must track the reported content height, not fill its parent.
     */
    <div className={cn('relative', autoHeight ? '' : 'h-full')}>
      <SandboxedHtmlFrame
        html={html}
        title={title}
        autoHeight={autoHeight}
        allowScripts={allowScripts}
        onError={onError}
        onSelectionChange={setSelection}
        onQueryReady={handleQueryReady}
        onContextChange={onContextChange}
      />

      {mode.kind === 'idle' && selection?.rect && <SelectionPopover rect={selection.rect} onAsk={askAboutSelection} />}

      {(mode.kind === 'drawing' || mode.kind === 'resolving') && (
        <MarqueeOverlay onSelect={resolveMarquee} onCancel={dismiss} />
      )}

      {mode.kind === 'reviewing' && (
        <SurfaceSelectionBar
          items={mode.items}
          onAsk={() => askAboutItems(mode.items)}
          onRetry={startMarquee}
          onCancel={dismiss}
        />
      )}

      {mode.kind === 'idle' && !selection && (
        <Button
          onClick={startMarquee}
          variant="secondary"
          size="sm"
          className="absolute bottom-3 right-3 z-10 rounded-full shadow-lg"
        >
          <MousePointerSquareDashed className="size-[var(--icon-size-sm)]" />
          <Trans>Select</Trans>
        </Button>
      )}
    </div>
  )
}
