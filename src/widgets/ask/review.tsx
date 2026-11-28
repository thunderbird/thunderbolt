/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Check, Sparkles, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { type SendStatus, SendStatusNote } from './display'
import { isGradedMode, type AskCacheEntry, type AskData } from './lib'

export type AskReviewItem = { ask: AskData; entry: AskCacheEntry }

/** The answer given, as the review shows it: the chosen options, a pointer to the message for "Other…", or a skip. */
const ReviewAnswer = ({ entry }: { entry: AskCacheEntry }) => {
  if (entry.skipped) {
    return (
      <p className="text-muted-foreground">
        <Trans>Skipped</Trans>
      </p>
    )
  }
  const chosen = entry.chosen.join(', ')
  if (!entry.other) {
    return <p className="text-foreground/80">{chosen}</p>
  }
  return (
    <p className="text-foreground/80">
      {chosen ? <Trans>{chosen}, and Other (in your message)</Trans> : <Trans>Other (in your message)</Trans>}
    </p>
  )
}

type AskReviewProps = {
  items: AskReviewItem[]
  /** Outcome of the send triggered by the submit that opened this review. */
  sendStatus?: SendStatus
  onRetrySend?: () => void
}

/** Read-only summary of a finished multi-question sequence: each prompt, the answer given, and its feedback. */
export const AskReview = ({ items, sendStatus = 'idle', onRetrySend }: AskReviewProps) => {
  const { t } = useLingui()

  return (
    <div className="my-4 w-full">
      <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 md:p-5">
        <div className="flex items-center gap-1.5 text-[length:var(--font-size-xs)] font-medium uppercase tracking-wide text-muted-foreground">
          <Sparkles className="size-[var(--icon-size-sm)]" />
          <span>
            <Trans>Your answers</Trans>
          </span>
        </div>
        <ol className="flex flex-col divide-y divide-border">
          {items.map(({ ask, entry }, index) => {
            const isGraded = isGradedMode(ask.mode) && !entry.skipped
            return (
              <li key={index} className="flex gap-3 py-3 first:pt-0 last:pb-0">
                {isGraded ? (
                  <span
                    className={cn(
                      'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full',
                      entry.matched ? 'bg-success text-success-foreground' : 'bg-destructive text-white',
                    )}
                    role="img"
                    // Neutral wording, like the rest of the widget: no right/wrong verdict.
                    aria-label={entry.matched ? t`Matches the answer` : t`Doesn't match the answer`}
                  >
                    {entry.matched ? (
                      <Check className="size-3" strokeWidth={3} />
                    ) : (
                      <X className="size-3" strokeWidth={3} />
                    )}
                  </span>
                ) : (
                  <span className="mt-0.5 size-5 shrink-0" aria-hidden />
                )}
                <div className="flex min-w-0 flex-col gap-1 text-[length:var(--font-size-sm)]">
                  <p className="font-medium text-foreground">{ask.prompt}</p>
                  <ReviewAnswer entry={entry} />
                  {isGraded && ask.explanation && <p className="text-muted-foreground">{ask.explanation}</p>}
                </div>
              </li>
            )
          })}
        </ol>
        <SendStatusNote status={sendStatus} onRetry={onRetrySend} />
      </div>
    </div>
  )
}
