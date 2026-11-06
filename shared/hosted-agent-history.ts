/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * History rules for the hosted agent's `POST /v1/agent/chat`, shared by the
 * backend that enforces them (`backend/src/hosted-agent/history.ts`) and the
 * client that shapes its request to meet them (`src/acp/managed-http-adapter.ts`).
 * A drift between the two surfaces as a code-less 400 the chat reads as a file
 * rejection, so every rule either side checks lives here.
 */

/** Most messages per request. Well past a long chat, and it bounds the work spent validating one request. */
export const maxHostedAgentHistoryMessages = 200

/** Part types replayed to the model, per role. The hosted agent takes no files from either. */
const hostedAgentPartTypes = {
  user: ['text'],
  assistant: ['text'],
} as const satisfies Record<'user' | 'assistant', readonly string[]>

type HostedAgentRole = keyof typeof hostedAgentPartTypes

/** Whether `type` is a part the endpoint replays for a message with this role. */
export const isHostedAgentPartType = (role: string, type: string): boolean =>
  role in hostedAgentPartTypes && (hostedAgentPartTypes[role as HostedAgentRole] as readonly string[]).includes(type)

/**
 * A text part with no visible text. `useChat` leaves one behind when a reply is
 * stopped as it starts, and Anthropic rejects the empty assistant message it
 * would become, so it is dropped rather than replayed.
 */
export const isBlankTextPart = (part: { type: string; text?: unknown }): boolean =>
  part.type === 'text' && typeof part.text === 'string' && part.text.trim() === ''

/**
 * Whether a history may be sent: it must start and end with a user message.
 * Anthropic treats a trailing assistant message as prefill, which would let a
 * caller write the start of the answer.
 */
export const startsAndEndsOnUserMessage = (messages: readonly { role: string }[]): boolean =>
  messages[0]?.role === 'user' && messages.at(-1)?.role === 'user'

/** Drop the messages before the first user message, so the history starts on one. */
export const startOnUserMessage = <Message extends { role: string }>(messages: Message[]): Message[] => {
  const firstUserIndex = messages.findIndex((message) => message.role === 'user')
  return firstUserIndex === -1 ? [] : messages.slice(firstUserIndex)
}
