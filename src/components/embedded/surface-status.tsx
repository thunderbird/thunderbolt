/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Shared status vocabulary for embedded surfaces (THU-852).
 *
 * Mini apps and artifacts sit in different sandboxes and always will — one is a
 * real origin over the network, the other is `srcdoc` with no origin at all —
 * but the situations a user meets are the same three: it's coming, it didn't
 * come, and it broke while running. Saying those three differently on each
 * surface means learning the product twice.
 *
 * So the words and the shapes live here, and each surface supplies only the
 * detail it alone knows: an app names its origin and the headers to check, an
 * artifact names the script error.
 */

import { Trans } from '@lingui/react/macro'
import { AlertTriangle } from 'lucide-react'
import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type EmbeddedSurfaceStatusProps = {
  /** What the user is waiting for, or what failed. Named, never "the content". */
  name: string
  /**
   * Which of the two states to present.
   *
   * A `state` rather than a `failed` boolean: `false` did not mean "fine", it
   * meant "still waiting", and the only caller reached it by double negation
   * from a three-member union (`failed={status !== 'connecting'}`). Naming the
   * two states puts that mapping in one place and makes the call site legible.
   */
  state: 'waiting' | 'failed'
  /** Surface-specific detail, shown only in the failed state — what to actually check. */
  detail?: ReactNode
  /** Offer another attempt. Omitted when the surface can't be retried. */
  onRetry?: () => void
}

/**
 * The pre-ready state: the surface is coming, or it never came.
 *
 * A card over the surface rather than a cover of it. The tempting version is a
 * full-bleed takeover — there's nothing to see yet, so why not — but that is
 * only true of a frame that failed to *load*. A frame that loaded and then
 * never handshook is very often showing the app's own sign-in screen, and a
 * takeover hides the one thing the user needs to click. So the card floats, the
 * container passes pointer events through, and only the card itself takes them.
 */
export const EmbeddedSurfaceStatus = ({ name, state, detail, onRetry }: EmbeddedSurfaceStatusProps) => (
  <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center p-4">
    <div className="pointer-events-auto max-w-sm space-y-2 rounded-xl border border-border bg-background/95 px-4 py-3 text-center shadow-lg backdrop-blur">
      {state === 'failed' ? (
        <>
          <p className="text-[length:var(--font-size-body)] font-medium">
            <Trans>Couldn&apos;t load {name}</Trans>
          </p>
          {detail && <div className="text-muted-foreground text-[length:var(--font-size-sm)]">{detail}</div>}
          {onRetry && (
            <Button variant="secondary" size="sm" onClick={onRetry}>
              <Trans>Try again</Trans>
            </Button>
          )}
        </>
      ) : (
        <p className="text-muted-foreground text-[length:var(--font-size-sm)]">
          <Trans>Loading {name}…</Trans>
        </p>
      )}
    </div>
  </div>
)

/**
 * The non-blocking state: the surface loaded and then something threw.
 *
 * Deliberately a strip rather than a takeover — the content is still on screen
 * and may be most of the way useful, so replacing it would destroy more than the
 * error did.
 */
export const EmbeddedErrorStrip = ({ message, className }: { message: string; className?: string }) => (
  <div
    className={cn(
      'flex items-center gap-2 border-b border-border bg-destructive/10 px-4 py-1.5 text-[length:var(--font-size-xs)] text-destructive',
      className,
    )}
  >
    <AlertTriangle className="size-3.5 shrink-0" />
    <span className="truncate">{message}</span>
  </div>
)
