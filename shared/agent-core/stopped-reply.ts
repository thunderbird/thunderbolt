/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AssistantMessage } from '@earendil-works/pi-ai'

/**
 * Stands in for a reply the user stopped before it had any text. Without an
 * answer after it, the stopped prompt looks unanswered and the model answers it
 * again on the next turn.
 *
 * Kept free of runtime imports so the app can read it without bundling the engine.
 */
export const stoppedReplyMarker = '[The user stopped this reply.]'

/**
 * The text a stopped reply should leave in the conversation: what the user saw
 * of it, or {@link stoppedReplyMarker} when nothing was written yet.
 *
 * @param message - the assistant message Pi recorded with `stopReason: 'aborted'`
 * @returns the partial reply text, or the marker
 */
export const stoppedReplyText = (message: AssistantMessage): string => {
  const text = message.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('')
    .trim()
  return text || stoppedReplyMarker
}
