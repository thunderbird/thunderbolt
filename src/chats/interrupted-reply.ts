/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ThunderboltUIMessage } from '@/types'

/** Identify a saved partial reply without replaying its potentially completed side effects. */
export const getInterruptedReplyId = (messages: readonly ThunderboltUIMessage[]): string | undefined => {
  const reply = messages.at(-1)
  if (reply?.role !== 'assistant' || reply.metadata?.turnOutcome) {
    return undefined
  }
  const prompt = messages.findLast((message) => message.role === 'user')
  if (prompt?.metadata?.stoppedByUser) {
    return undefined
  }
  const unfinished = reply.parts.some((part) =>
    part.type === 'text' || part.type === 'reasoning'
      ? part.state === 'streaming'
      : 'toolCallId' in part &&
        ['input-streaming', 'input-available', 'approval-requested', 'approval-responded'].includes(part.state),
  )
  return unfinished ? reply.id : undefined
}
