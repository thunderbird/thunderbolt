/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AgentHarness, AgentMessage } from '@earendil-works/pi-agent-core'

/** Sent to the model, never shown to the user, after its reply ran out of room while reasoning.
 *  It is a real user message in the Pi session, so it stays in the model's context for later
 *  turns, and a compaction's retained tail carries it across a harness rebuild. */
export const outputLimitNudge =
  'Your previous reply hit the output limit while you were still reasoning, so nothing reached the user. ' +
  'Keep your reasoning brief, then answer or call the tool now.'

/**
 * Whether the output limit cut a reply off before it wrote any text or tool call.
 * Pi ends the run on such a reply (there is no tool call to run), so without
 * help the user would get the reasoning and nothing else.
 *
 * @param message - a message from the harness run
 * @returns true for an assistant reply with `stopReason: 'length'` and no answer in it
 */
export const isCutOffBeforeAnswer = (message: AgentMessage): boolean =>
  message.role === 'assistant' &&
  message.stopReason === 'length' &&
  !message.content.some((block) => block.type === 'toolCall' || (block.type === 'text' && block.text.trim() !== ''))

/**
 * Continue a run once when its reply was cut off before answering, with a
 * follow-up asking the model to answer now. Pi queues the follow-up and drains it
 * when the run would otherwise stop. At most one per user turn: if the second
 * reply is cut off too, the run ends and the UI stream reports the error.
 *
 * @param harness - the harness to watch for its whole lifetime
 * @returns a function that stops watching
 */
export const installOutputLimitRecovery = (harness: Pick<AgentHarness, 'subscribe' | 'followUp'>): (() => void) => {
  const state = { recovered: false }
  return harness.subscribe(async (event) => {
    if (event.type === 'agent_start') {
      state.recovered = false
      return
    }
    if (event.type === 'turn_end' && !state.recovered && isCutOffBeforeAnswer(event.message)) {
      state.recovered = true
      await harness.followUp(outputLimitNudge)
    }
  })
}
