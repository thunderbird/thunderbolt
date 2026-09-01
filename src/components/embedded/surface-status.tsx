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

import { cn } from '@/lib/utils'

type EmbeddedSurfaceStatusProps = {
  /** What the user is waiting for, or what failed. Named, never "the content". */
  name: string
  /** Present the failed state; otherwise this is the waiting state. */
  failed?: boolean
  /** Surface-specific detail, shown only when failed — what to actually check. */
  detail?: ReactNode
}

/**
 * The blocking state: covers the frame while a surface is loading, or instead of
 * it when the surface never arrived.
 *
 * Blocking is right for both, because in neither case is there anything behind
 * it to look at.
 */
export const EmbeddedSurfaceStatus = ({ name, failed = false, detail }: EmbeddedSurfaceStatusProps) => (
  <div className="absolute inset-0 flex items-center justify-center bg-background p-6 text-center">
    {failed ? (
      <div className="max-w-sm space-y-2">
        <p className="text-[length:var(--font-size-body)] font-medium">
          <Trans>Couldn&apos;t load {name}</Trans>
        </p>
        {detail && <div className="text-muted-foreground text-[length:var(--font-size-sm)]">{detail}</div>}
      </div>
    ) : (
      <p className="text-muted-foreground text-[length:var(--font-size-sm)]">
        <Trans>Loading {name}…</Trans>
      </p>
    )}
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
      'flex items-center gap-2 border-b border-border bg-destructive/10 px-4 py-1.5 text-xs text-destructive',
      className,
    )}
  >
    <AlertTriangle className="size-3.5 shrink-0" />
    <span className="truncate">{message}</span>
  </div>
)
