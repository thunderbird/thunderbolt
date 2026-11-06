/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLingui } from '@lingui/react/macro'
import { m } from 'framer-motion'
import { AlertCircle, X } from 'lucide-react'
import type { ReactNode } from 'react'

type ComposerAlertProps = {
  children: ReactNode
  /** Renders a dismiss button; omit it for a banner that clears with its cause. */
  onDismiss?: () => void
}

/**
 * Destructive banner above the composer: an attachment error, or why the send
 * is held. Give it a `key` at the call site so `AnimatePresence` can animate it
 * out.
 */
export const ComposerAlert = ({ children, onDismiss }: ComposerAlertProps) => {
  const { t } = useLingui()

  return (
    <m.div
      // marginBottom pulls the banner's bottom -12px below the composer's
      // top edge so it's hidden behind the composer's opaque z-10 body
      // (the "emerges from behind" look). Animated in lockstep with height
      // so dismiss collapses cleanly without over-pulling the chips.
      initial={{ height: 0, opacity: 0, marginBottom: 0 }}
      animate={{ height: 'auto', opacity: 1, marginBottom: -12 }}
      exit={{ height: 0, opacity: 0, marginBottom: 0 }}
      transition={{ type: 'tween', ease: [0.2, 0.9, 0.1, 1], duration: 0.25 }}
      className="pointer-events-auto overflow-hidden"
    >
      <div
        role="alert"
        className="flex items-center gap-1.5 rounded-t-2xl bg-destructive/10 px-3 pb-4 pt-2 text-[length:var(--font-size-xs)] text-destructive"
      >
        <AlertCircle className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">{children}</span>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label={t`Dismiss`}
            className="shrink-0 cursor-pointer rounded p-0.5 hover:bg-destructive/15"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
    </m.div>
  )
}
