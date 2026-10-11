/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  isBlankTextPart,
  isHostedAgentPartType,
  maxHostedAgentHistoryMessages,
  startsAndEndsOnUserMessage,
} from '@shared/hosted-agent-history'
import type { UIMessage } from 'ai'
import { z } from 'zod'

/**
 * Parts the client may replay. Each schema rebuilds the part from known fields only, so client-forged
 * `providerMetadata` never reaches the provider. Files must be inline data URLs: a remote URL would make
 * the AI SDK download it from this server. Blank text parts are dropped (see `isBlankTextPart`).
 */
const textPartSchema = z
  .object({ type: z.literal('text'), text: z.string() })
  .transform((part) => (isBlankTextPart(part) ? null : part))
const filePartSchema = z.object({
  type: z.literal('file'),
  mediaType: z.string(),
  url: z.string().startsWith('data:'),
  filename: z.string().optional(),
})

/**
 * Parts dropped from the replay. The server registers no tools and enables no extended thinking, so tool and
 * reasoning parts were not produced by it (a replayed reasoning part also lacks the signature Anthropic
 * requires). `step-start` is a UI step marker that carries no content.
 */
const droppedPartSchema = z
  .object({ type: z.string().regex(/^(tool-.+|dynamic-tool|reasoning|step-start)$/) })
  .transform(() => null)

/** Remove the parts the schemas above mapped to null. */
const withoutDroppedParts = <Part>(parts: (Part | null)[]): Part[] => parts.filter((part) => part !== null)

/**
 * A role's replayed parts. A part type the role may not send rejects the request, and that includes
 * every file: file parts still parse above so the shared rule (`isHostedAgentPartType`) is what refuses
 * them, which leaves room for a coded file check ahead of these schemas.
 */
const partsSchemaFor = (role: 'user' | 'assistant') =>
  z
    .array(z.union([textPartSchema, filePartSchema, droppedPartSchema]))
    .transform(withoutDroppedParts)
    .refine((parts) => parts.every((part) => isHostedAgentPartType(role, part.type)))

const messageSchema = z.discriminatedUnion('role', [
  z.object({ id: z.string(), role: z.literal('user'), parts: partsSchemaFor('user') }),
  z.object({ id: z.string(), role: z.literal('assistant'), parts: partsSchemaFor('assistant') }),
  // Client system messages are dropped whole, so their parts are never inspected.
  z.object({ id: z.string(), role: z.literal('system'), parts: z.array(z.unknown()) }),
])

const requestSchema = z.object({
  id: z.string(),
  messages: z.array(messageSchema).max(maxHostedAgentHistoryMessages),
})

export type AgentChatRequest = { id: string; messages: UIMessage[] }

/**
 * Parse a `DefaultChatTransport` body into a history safe to send to the model. Client system messages and
 * the parts above are dropped. Too many messages, unknown part types, and file parts are rejected, as is
 * a history that does not start and end with a user message (see `startsAndEndsOnUserMessage`). The byte
 * cap is enforced earlier,
 * while the body is read (see `readBoundedJson`).
 */
export const parseAgentChatRequest = (body: unknown): AgentChatRequest | null => {
  const parsed = requestSchema.safeParse(body)
  if (!parsed.success) {
    return null
  }
  const messages = parsed.data.messages.flatMap((message) => {
    if (message.role === 'system') {
      return []
    }
    return message.parts.length === 0 ? [] : [{ id: message.id, role: message.role, parts: message.parts }]
  })
  if (!startsAndEndsOnUserMessage(messages)) {
    return null
  }
  return { id: parsed.data.id, messages }
}
