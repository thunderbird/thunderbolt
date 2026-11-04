/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

type StreamPart = { type: string; toolCallId?: string }

/**
 * `messageMetadata` for the hosted agent's UI stream that times each tool call, the way the built-in pipeline
 * does (`createMessageMetadata`, `src/ai/message-metadata.ts`): its start when it is called, its duration once it
 * settles. The chat's tool rows and their group title read these, and show 0ms without them.
 */
export const createToolTimingMetadata = (now: () => number = Date.now) => {
  const startTimes = new Map<string, number>()
  return ({ part }: { part: StreamPart }) => {
    if (!part.toolCallId) {
      return undefined
    }
    if (part.type === 'tool-call') {
      const start = now()
      startTimes.set(part.toolCallId, start)
      return { reasoningStartTimes: { [part.toolCallId]: start } }
    }
    const start = startTimes.get(part.toolCallId)
    if ((part.type === 'tool-result' || part.type === 'tool-error') && start !== undefined) {
      return { reasoningTime: { [part.toolCallId]: now() - start } }
    }
    return undefined
  }
}
