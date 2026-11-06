/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { cn } from '@/lib/utils'
import { Trans } from '@lingui/react/macro'
import { m } from 'framer-motion'
import { AlertCircle, Loader2 } from 'lucide-react'

type ImageSupportNoticeProps = {
  status: 'checking' | 'unsupported'
  modelName: string
  /** Shown as a "Try anyway" action on the unsupported banner, when the verdict can be overruled. */
  onTryAnyway?: () => void
}

/**
 * Banner above the composer while an image blocks sending: either the model's
 * image support is still being checked, or the model can't read images. Shares
 * the attachment-error banner's "emerges from behind the composer" motion.
 */
export const ImageSupportNotice = ({ status, modelName, onTryAnyway }: ImageSupportNoticeProps) => (
  <m.div
    initial={{ height: 0, opacity: 0, marginBottom: 0 }}
    animate={{ height: 'auto', opacity: 1, marginBottom: -12 }}
    exit={{ height: 0, opacity: 0, marginBottom: 0 }}
    transition={{ type: 'tween', ease: [0.2, 0.9, 0.1, 1], duration: 0.25 }}
    className="pointer-events-auto overflow-hidden"
  >
    <div
      // A blocked send is announced assertively (alert); progress politely (status).
      role={status === 'unsupported' ? 'alert' : 'status'}
      className={cn(
        'flex items-center gap-1.5 rounded-t-2xl px-3 pb-4 pt-2 text-[length:var(--font-size-xs)]',
        status === 'unsupported' ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground',
      )}
    >
      {status === 'unsupported' ? (
        <>
          <AlertCircle className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <Trans>{modelName} can&apos;t read images. Switch to a model that can, or remove the image.</Trans>
          </span>
          {onTryAnyway && (
            <button
              type="button"
              onClick={onTryAnyway}
              className="shrink-0 cursor-pointer rounded-md px-1.5 py-0.5 font-medium hover:bg-destructive/15"
            >
              <Trans>Try anyway</Trans>
            </button>
          )}
        </>
      ) : (
        <>
          <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <Trans>Checking whether {modelName} can read images…</Trans>
          </span>
        </>
      )}
    </div>
  </m.div>
)
