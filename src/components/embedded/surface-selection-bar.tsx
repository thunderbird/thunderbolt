/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The confirm step after a marquee, shared by both embedded surfaces.
 *
 * This was twenty lines of identical JSX and five identical strings in two
 * files. Sharing it is the difference between the two surfaces agreeing by
 * intention and agreeing by coincidence — the copies had already begun to
 * diverge, one saying "Nothing selectable in that area" while the other had been
 * reworded.
 */

import { Plural, Trans } from '@lingui/react/macro'

import { Button } from '@/components/ui/button'
import type { SurfaceSelectionItem } from './types'

type SurfaceSelectionBarProps = {
  items: SurfaceSelectionItem[]
  /** Take the selection to the composer. */
  onAsk: () => void
  /** Draw another box — offered only when nothing was found. */
  onRetry: () => void
  onCancel: () => void
}

export const SurfaceSelectionBar = ({ items, onAsk, onRetry, onCancel }: SurfaceSelectionBarProps) => {
  const found = items.length > 0

  return (
    <div className="absolute inset-x-0 bottom-0 z-30 flex items-center justify-center gap-3 border-t bg-background/95 px-4 py-3 backdrop-blur">
      <span className="text-[length:var(--font-size-sm)] text-muted-foreground">
        {found ? (
          <Plural value={items.length} one="# item selected" other="# items selected" />
        ) : (
          <Trans>Nothing to ask about there. Try covering some content.</Trans>
        )}
      </span>
      {found && (
        <Button size="sm" onClick={onAsk}>
          <Plural value={items.length} one="Ask about it" other="Ask about them" />
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={found ? onCancel : onRetry}>
        {found ? <Trans>Cancel</Trans> : <Trans>Try again</Trans>}
      </Button>
    </div>
  )
}
