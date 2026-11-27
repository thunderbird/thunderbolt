/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ThunderboltUIMessage } from '@/types'

/** DOM id of a response's screen-reader heading, which "Go to latest response" focuses. */
export const responseHeadingId = (messageId: string) => `response-heading-${messageId}`

/**
 * The newest assistant message that renders as a response. Skips the hidden
 * OAuth-retry turn and an empty assistant shell, which `ChatMessages` doesn't show.
 */
export const findLatestResponseId = (messages: ThunderboltUIMessage[]): string | undefined =>
  messages.findLast(
    (message) => message.role === 'assistant' && message.metadata?.oauthRetry !== true && message.parts.length > 0,
  )?.id
