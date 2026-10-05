/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { UIMessage } from 'ai'
import { z } from 'zod'

export const maxHistoryMessages = 200

/**
 * Parts the client may replay. Each schema rebuilds the part from known fields only, so client-forged
 * `providerMetadata` never reaches the provider. Files must be inline data URLs: a remote URL would make
 * the AI SDK download it from this server.
 */
const textPartSchema = z.object({ type: z.literal('text'), text: z.string() })
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

const messageSchema = z.discriminatedUnion('role', [
  z.object({
    id: z.string(),
    role: z.literal('user'),
    parts: z.array(z.union([textPartSchema, filePartSchema, droppedPartSchema])),
  }),
  z.object({
    id: z.string(),
    role: z.literal('assistant'),
    parts: z.array(z.union([textPartSchema, droppedPartSchema])),
  }),
  // Client system messages are dropped whole, so their parts are never inspected.
  z.object({ id: z.string(), role: z.literal('system'), parts: z.array(z.unknown()) }),
])

const requestSchema = z.object({
  id: z.string(),
  messages: z.array(messageSchema).max(maxHistoryMessages),
})

/** Malformed JSON parses to `undefined`, which the request schema then rejects as a 400. */
const parseJson = (rawBody: string): unknown => {
  try {
    return JSON.parse(rawBody)
  } catch {
    return undefined
  }
}

export type AgentChatRequest = { id: string; messages: UIMessage[] }

export type ParseAgentChatResult = { ok: true; request: AgentChatRequest } | { ok: false; status: 400 }

/**
 * Parse a `DefaultChatTransport` body into a history safe to send to the model. Client system messages and
 * the parts above are dropped. Too many messages, unknown part types, and assistant files are rejected, as is
 * a history that does not start and end with a user message: Anthropic treats a trailing assistant message
 * as prefill, which would let a caller write the start of the answer. The byte cap is enforced earlier,
 * while the body is read (see `readBodyWithinLimit`).
 */
export const parseAgentChatRequest = (rawBody: string): ParseAgentChatResult => {
  const parsed = requestSchema.safeParse(parseJson(rawBody))
  if (!parsed.success) {
    return { ok: false, status: 400 }
  }
  const messages = parsed.data.messages.flatMap((message) => {
    if (message.role === 'system') {
      return []
    }
    const replayable = message.parts.flatMap((part) => (part === null ? [] : [part]))
    return replayable.length === 0 ? [] : [{ id: message.id, role: message.role, parts: replayable }]
  })
  if (messages[0]?.role !== 'user' || messages.at(-1)?.role !== 'user') {
    return { ok: false, status: 400 }
  }
  return { ok: true, request: { id: parsed.data.id, messages } }
}
