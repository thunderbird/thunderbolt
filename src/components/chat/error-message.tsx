/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { maxRetries } from '@/chats/chat-instance'
import {
  type ChatErrorKind,
  getChatErrorKind,
  getInferenceQuotaWindow,
  type InferenceQuotaWindow,
  isContextOverflowError,
  isRateLimitError,
} from '@/lib/error-utils'
import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { Loader2 } from 'lucide-react'
import { memo } from 'react'

const defaultChatErrorMessage = msg`Something went wrong. Please try again.`
const causeSpecificErrorMessages: Partial<Record<ChatErrorKind, MessageDescriptor>> = {
  attestation: msg`Couldn't verify the secure AI connection. This is usually temporary — try again in a moment.`,
  timeout: msg`The AI provider took too long to respond. Try again.`,
  provider: msg`The AI provider is having trouble right now. Try again in a moment.`,
  network: msg`Connection problem. Check your internet and try again.`,
  'connection-lost': msg`The agent connection was lost during the previous turn. Retrying may repeat actions the agent already performed.`,
}
const inferenceQuotaMessages = {
  '5h': msg`You've reached your AI usage limit for the current 5-hour window. Try again later.`,
  '7d': msg`You've reached your AI usage limit for the current 7-day window. Try again later.`,
} satisfies Record<InferenceQuotaWindow, MessageDescriptor>

/** Resolve final chat error copy after automatic retries stop. */
const getFinalChatErrorMessage = (error?: Error | null): MessageDescriptor => {
  const kind = getChatErrorKind(error)
  return (kind && causeSpecificErrorMessages[kind]) || defaultChatErrorMessage
}

type ErrorMessageProps = {
  retryCount: number
  retriesExhausted: boolean
  error?: Error | null
  onRetry?: () => void
  /** True when the turn failed on an unreadable attachment with no delivery mode
   *  left to try — shows file-specific guidance instead of the generic message. */
  deliveryExhausted?: boolean
}

export const ErrorMessage = memo(
  ({ retryCount, retriesExhausted, error, onRetry, deliveryExhausted }: ErrorMessageProps) => {
    const { i18n } = useLingui()
    const rateLimited = isRateLimitError(error)
    const inferenceQuotaWindow = getInferenceQuotaWindow(error)

    // Show rate limit message immediately — don't auto-retry since the server told us to slow down
    if (rateLimited) {
      return (
        <div className="px-4 py-3 rounded-2xl bg-amber-500/10 mr-auto w-full mt-2">
          {inferenceQuotaWindow ? (
            <div className="space-y-1">
              <p className="font-medium text-foreground text-[length:var(--font-size-body)]">
                <Trans>AI usage limit reached</Trans>
              </p>
              <p className="text-foreground text-[length:var(--font-size-body)]">
                {i18n._(inferenceQuotaMessages[inferenceQuotaWindow])}
              </p>
            </div>
          ) : (
            <p className="text-amber-500/80 text-[length:var(--font-size-body)]">
              <Trans>Too many requests. Please try again in a moment.</Trans>
            </p>
          )}
        </div>
      )
    }

    // Context-window overflow — retrying won't help; guide the user to shrink the
    // request rather than show a generic error.
    if (isContextOverflowError(error)) {
      return (
        <div className="px-4 py-3 rounded-2xl bg-amber-500/10 mr-auto w-full mt-2">
          <p className="text-amber-500/80 text-[length:var(--font-size-body)]">
            <Trans>
              This conversation is too large for the model&apos;s context window. Start a new chat, remove some
              attachments, or switch to a model with a larger context window.
            </Trans>
          </p>
        </div>
      )
    }

    // Show spinner only when a retry is actively in progress (retryCount > 0).
    // retryCount === 0 means either stale error (page refresh) or fresh error
    // before onFinish has scheduled a retry — in both cases show the Retry button.
    if (retryCount > 0 && !retriesExhausted) {
      return (
        <div className="px-4 py-3 rounded-2xl bg-amber-500/10 mr-auto w-full mt-2">
          <div className="flex items-center gap-2">
            <Loader2 className="size-[var(--icon-size-sm)] text-amber-500 animate-spin" />
            <p className="text-amber-500/80 text-[length:var(--font-size-body)]">
              <Trans>
                Something went wrong. Retrying ({retryCount}/{maxRetries})…
              </Trans>
            </p>
          </div>
        </div>
      )
    }

    return (
      <div className="px-4 py-3 rounded-2xl bg-destructive/10 mr-auto w-full mt-2">
        <div className="flex items-center justify-between gap-2 min-h-[var(--touch-height-sm)]">
          <p className="text-destructive/80 text-[length:var(--font-size-body)]">
            {deliveryExhausted ? (
              <Trans>This model couldn&apos;t read the attached file. Try a different model.</Trans>
            ) : (
              i18n._(getFinalChatErrorMessage(error))
            )}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            {/* No Retry when delivery is exhausted — re-running identical input fails
                identically; the message directs the user to switch models instead. */}
            {onRetry && !deliveryExhausted && (
              <button
                type="button"
                onClick={onRetry}
                className="cursor-pointer text-[length:var(--font-size-body)] font-medium text-destructive/90 bg-destructive/10 hover:bg-destructive/15 px-3 py-1 rounded-xl"
              >
                <Trans>Retry</Trans>
              </button>
            )}
          </div>
        </div>
      </div>
    )
  },
)
