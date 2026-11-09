/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { MousePointerClick } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type ElementPickBannerProps = {
  /** Whether picking is on. Stays mounted while off so it can animate both ways. */
  open: boolean
  /** A tap has chosen an element, and it is waiting to be confirmed. */
  canConfirm: boolean
  onConfirm: () => void
  onCancel: () => void
}

const BannerMessage = ({ canConfirm }: { canConfirm: boolean }) =>
  canConfirm ? <Trans>Add to chat?</Trans> : <Trans>Select an element to add it to the chat</Trans>

/**
 * Says that element picking is on, what it does, and how to leave it. After a
 * tap it also commits the choice, since touch has no hover to preview with.
 *
 * Laid out below the surface rather than floated over it: anything floating
 * would hide part of the content being picked from, and picking captures the
 * pointer, so the user couldn't scroll that content back out from underneath.
 * Below because that's where Select was clicked, and in the overlay ring's color
 * so the two read as one frame around the surface.
 *
 * The bar leads the space it takes on the way in and trails it on the way out.
 * An iframe repaints a little behind its own resize, so the frame's moving edge
 * has to stay covered, or its white background shows in the gap the guest
 * hasn't painted yet.
 *
 * The parent must clip its overflow: the closed bar is parked just below it, and
 * a transformed box still counts as scrollable area in a scrolling ancestor.
 *
 * The status line is separate from the visible text because a live region is
 * only announced when its content changes, and the banner is always mounted.
 */
export const ElementPickBanner = ({ open, canConfirm, onConfirm, onCancel }: ElementPickBannerProps) => (
  <>
    <span role="status" className="sr-only">
      {open && <BannerMessage canConfirm={canConfirm} />}
    </span>
    <div
      inert={!open}
      className={cn(
        'relative z-50 shrink-0 transition-[height] duration-200 ease-out motion-reduce:transition-none',
        open ? 'h-[calc(var(--touch-height-sm)+0.375rem)] delay-75' : 'h-0 delay-0',
      )}
    >
      {/* `pt-0.5` because the ring's bottom edge adds 2px above, in the same color. */}
      <div
        className={cn(
          'absolute inset-x-0 bottom-0 flex items-center gap-2 bg-secondary pt-0.5 pr-1 pb-1 pl-4 text-secondary-foreground transition-transform duration-200 ease-out motion-reduce:transition-none',
          open ? 'translate-y-0 delay-0' : 'translate-y-full delay-75',
        )}
      >
        <MousePointerClick className="size-[var(--icon-size-sm)] shrink-0 pointer-coarse:hidden" />
        <span aria-hidden className="min-w-0 flex-1 truncate text-[length:var(--font-size-sm)]">
          <BannerMessage canConfirm={canConfirm} />
        </span>
        <Button onClick={onCancel} variant="outline" size="sm" aria-keyshortcuts="Escape" className="shrink-0">
          {canConfirm ? <Trans>Deselect</Trans> : <Trans>Cancel</Trans>}
        </Button>
        {canConfirm && (
          <Button onClick={onConfirm} size="sm" className="shrink-0">
            <Trans>Add</Trans>
          </Button>
        )}
      </div>
    </div>
  </>
)
