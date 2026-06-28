/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Maps a thread's prior conversation turns into Pi {@link AgentMessage}s so a
 * freshly built harness starts with that history seeded into its session
 * (`harness.appendMessage`). Without it the harness is prompted with only the
 * latest user turn and the agent forgets everything said before — every turn
 * would start from a blank transcript.
 *
 * Only the *text* of each prior turn is carried across: tool calls/results and
 * images from earlier turns are intentionally dropped. Faithfully rebuilding
 * Pi's `tool_use`/`tool_result` pairing (matched ids, schemas) from the AI-SDK UI
 * message shape is fragile and unnecessary for conversational context — the agent
 * re-runs any tool it still needs. Prior assistant turns are rebuilt via Pi's
 * exported `fauxAssistantMessage` helper, the supported way to synthesize a
 * well-formed `AssistantMessage` without hand-fabricating its usage/provider
 * metadata (none of which is sent on the wire for a historical turn anyway).
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { fauxAssistantMessage } from '@earendil-works/pi-ai'

/** A prior conversation turn reduced to its role and concatenated text. The app
 *  derives these from its `ThunderboltUIMessage[]` using app types only, so it can
 *  build the seed list without statically importing (and bundling) the engine. */
export type SeedTurn = {
  readonly role: 'user' | 'assistant'
  readonly text: string
}

/**
 * Build the Pi {@link AgentMessage}s for a list of prior turns, ready to seed into
 * a harness session in order. Empty-text turns are skipped so the transcript never
 * carries a content-less message (e.g. an assistant turn that only ran tools).
 *
 * @param turns - prior conversation turns (role + text); omitted/all-empty yields `[]`
 * @returns the equivalent Pi agent messages, in order
 */
export const buildSeedMessages = (turns: readonly SeedTurn[] = []): AgentMessage[] =>
  turns
    .filter((turn) => turn.text.length > 0)
    .map(
      (turn): AgentMessage =>
        turn.role === 'user'
          ? { role: 'user', content: turn.text, timestamp: Date.now() }
          : fauxAssistantMessage(turn.text),
    )
