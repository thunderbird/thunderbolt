/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ThunderboltUIMessage } from '@/types'
import { stoppedReplyMarker } from '@shared/agent-core/stopped-reply'

/** Only visible answer text counts, not reasoning or tool output. */
const hasReplyText = (message: ThunderboltUIMessage): boolean =>
  message.parts.some((part) => part.type === 'text' && part.text.trim().length > 0)

/**
 * Add a stop marker after each prompt the user stopped before any reply text
 * came back. Without it the prompt looks unanswered: the built-in agent merges
 * it into the next prompt, and other models answer both.
 *
 * A stopped reply that already had text needs nothing, because the model sees
 * that text. The latest prompt is never marked, since it is the one being sent.
 *
 * @param messages - the thread's messages, in order
 * @returns the messages with a marker reply after each unanswered stopped prompt
 */
export const withStoppedReplyMarkers = (messages: ThunderboltUIMessage[]): ThunderboltUIMessage[] =>
  messages.flatMap((message, index) => {
    if (messages[index + 1]?.role !== 'user') {
      return [message]
    }
    const promptIndex = messages.findLastIndex((candidate, i) => i <= index && candidate.role === 'user')
    const prompt = messages[promptIndex]
    if (!prompt?.metadata?.stoppedByUser || messages.slice(promptIndex + 1, index + 1).some(hasReplyText)) {
      return [message]
    }
    const marker: ThunderboltUIMessage = {
      id: `${prompt.id}-stopped`,
      role: 'assistant',
      parts: [{ type: 'text', text: stoppedReplyMarker }],
    }
    return [message, marker]
  })
