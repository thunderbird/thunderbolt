/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { fauxAssistantMessage } from '@earendil-works/pi-ai'

/** Saved model-facing evidence for one tool invocation, never a request to execute it again. */
type SeedToolCall = {
  readonly id: string
  readonly name: string
  readonly input: Record<string, unknown>
  readonly output: string
  readonly isError: boolean
}

/** Ordered conversation content, independent of provider-specific message metadata. */
export type SeedTurn = {
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly toolCall?: SeedToolCall
}

/** Restore conversation and matched tool pairs into an idle session without rerunning tools. */
export const buildSeedMessages = (turns: readonly SeedTurn[] = []): AgentMessage[] =>
  turns.flatMap((turn): AgentMessage[] => {
    if (turn.role === 'assistant' && turn.toolCall) {
      const tool = turn.toolCall
      return [
        fauxAssistantMessage(
          { type: 'toolCall', id: tool.id, name: tool.name, arguments: tool.input },
          { stopReason: 'toolUse' },
        ),
        {
          role: 'toolResult',
          toolCallId: tool.id,
          toolName: tool.name,
          content: [{ type: 'text', text: tool.output }],
          isError: tool.isError,
          timestamp: Date.now(),
        },
      ]
    }
    if (!turn.text) {
      return []
    }
    return [
      turn.role === 'user'
        ? { role: 'user', content: turn.text, timestamp: Date.now() }
        : fauxAssistantMessage(turn.text),
    ]
  })
