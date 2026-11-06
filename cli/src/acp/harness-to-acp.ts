/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Translator: Pi {@link AgentHarness} run → ACP `session/update` notifications.
 *
 * The inverse of `src/acp/translators/acp-to-ai-sdk.ts` (which consumes ACP
 * updates) and the ACP-shaped sibling of `shared/agent-core/pi-to-aisdk-stream.ts`
 * (which emits AI SDK chunks for the in-browser app). Here a harness drives an
 * ACP *client* over the wire, so each Pi event becomes a {@link SessionUpdate}.
 *
 * Event mapping (Pi `AgentHarnessEvent` → ACP `SessionUpdate`):
 *   message_update (text_delta)      → agent_message_chunk (text)
 *   message_update (thinking_delta)  → agent_thought_chunk (text)
 *   tool_execution_start             → tool_call    { status: in_progress }
 *   tool_execution_end               → tool_call_update { completed | failed }
 *
 * Lifecycle events (agent_start, turn_start, turn_end, agent_end) have no ACP
 * `sessionUpdate` equivalent — the ACP turn lifecycle is the `session/prompt`
 * request/response itself — so they are dropped here; the prompt handler maps
 * the final {@link StopReason} from the harness's resolved `AssistantMessage`.
 */

import type { StopReason as PiStopReason } from '@earendil-works/pi-ai'
import type { AgentHarnessEvent } from '@earendil-works/pi-agent-core'
import type { SessionUpdate, StopReason, ToolCallContent } from '@agentclientprotocol/sdk'
import { toAcpToolKind } from '../../../shared/agent-tool-permissions.ts'

/** Map a built-in tool name to its ACP {@link ToolKind}. */
export const toToolKind = (toolName: string) => (toolName === 'webfetch' ? 'fetch' : toAcpToolKind(toolName))

/**
 * Map a Pi {@link PiStopReason} to the ACP {@link StopReason} returned from
 * `session/prompt`. `error` has no ACP stop reason — the prompt handler surfaces
 * it as a JSON-RPC error instead — so it falls through to `end_turn` here only as
 * a defensive default that the handler never actually reaches.
 */
export const toAcpStopReason = (reason: PiStopReason): StopReason => {
  switch (reason) {
    case 'length':
      return 'max_tokens'
    case 'aborted':
      return 'cancelled'
    case 'stop':
    case 'toolUse':
    case 'error':
      return 'end_turn'
  }
}

/** Narrows an unknown tool-result content block to one carrying text. */
const isTextContent = (block: unknown): block is { text: string } =>
  typeof block === 'object' && block !== null && typeof (block as { text?: unknown }).text === 'string'

/**
 * Map a Pi `AgentToolResult` to ACP `ToolCallContent[]`, keeping the text blocks
 * the client renders. Returns `undefined` when the result carries no text so the
 * update relies on `rawOutput` alone rather than emitting an empty collection.
 */
const toToolCallContent = (result: unknown): ToolCallContent[] | undefined => {
  if (typeof result !== 'object' || result === null) return undefined
  const content = (result as { content?: unknown }).content
  if (!Array.isArray(content)) return undefined
  const blocks: ToolCallContent[] = content
    .filter(isTextContent)
    .map((block) => ({ type: 'content', content: { type: 'text', text: block.text } }))
  return blocks.length > 0 ? blocks : undefined
}

/** Sink for the {@link SessionUpdate}s a translator produces. The agent wraps
 *  this to call `connection.sessionUpdate({ sessionId, update })`. */
export type AcpUpdateSink = (update: SessionUpdate) => void

/**
 * Builds a stateless translator that turns each harness event into zero or one
 * ACP {@link SessionUpdate}, pushed into `emit`. Stateless because the ACP
 * client tracks its own per-`toolCallId` lifecycle — unlike the AI SDK stream,
 * which has to synthesize start/end part boundaries.
 *
 * @param emit - sink invoked once per produced session update
 * @returns an object exposing `handle` to feed it harness events
 */
export const createHarnessToAcpTranslator = (emit: AcpUpdateSink): { handle: (event: AgentHarnessEvent) => void } => {
  const handle = (event: AgentHarnessEvent): void => {
    switch (event.type) {
      case 'message_update': {
        const inner = event.assistantMessageEvent
        if (inner.type === 'text_delta') {
          emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: inner.delta } })
        } else if (inner.type === 'thinking_delta') {
          emit({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: inner.delta } })
        }
        return
      }
      case 'tool_execution_start': {
        emit({
          sessionUpdate: 'tool_call',
          toolCallId: event.toolCallId,
          title: event.toolName,
          kind: toToolKind(event.toolName),
          status: 'in_progress',
          rawInput: event.args ?? {},
        })
        return
      }
      case 'tool_execution_end': {
        emit({
          sessionUpdate: 'tool_call_update',
          toolCallId: event.toolCallId,
          status: event.isError ? 'failed' : 'completed',
          rawOutput: event.result as unknown,
          content: toToolCallContent(event.result),
        })
        return
      }
      // Lifecycle events (agent_start, turn_start/turn_end, message_*, agent_end)
      // and every other harness hook have no ACP `sessionUpdate`; the turn
      // lifecycle is the `session/prompt` request/response itself.
      default:
        return
    }
  }

  return { handle }
}
