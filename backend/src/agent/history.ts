/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { UIMessage } from 'ai'
import { z } from 'zod'

export const maxHistoryMessages = 200
export const maxRequestBytes = 2_000_000

/**
 * Parts the client may replay. Each schema rebuilds the part from known fields only, so client-forged
 * `providerMetadata` never reaches the provider. Files must be inline data URLs: a remote URL would make
 * the AI SDK download it from this server.
 */
const replayablePartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('step-start') }),
  z.object({
    type: z.literal('file'),
    mediaType: z.string(),
    url: z.string().startsWith('data:'),
    filename: z.string().optional(),
  }),
])

/**
 * The server registers no tools and enables no extended thinking, so tool and reasoning parts in the history
 * were not produced by it. A replayed reasoning part also lacks the provider signature Anthropic requires.
 */
const unproducedPartSchema = z
  .object({ type: z.string().regex(/^(tool-.+|dynamic-tool|reasoning)$/) })
  .transform(() => null)

const messageSchema = z.object({
  id: z.string(),
  role: z.enum(['system', 'user', 'assistant']),
  parts: z.array(z.union([replayablePartSchema, unproducedPartSchema])),
})

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

/** Whether a `Content-Length` header declares a body over the cap, so it can be refused before it is read. */
export const declaresOversizedBody = (contentLength: string | null): boolean => Number(contentLength) > maxRequestBytes

export type AgentChatRequest = { id: string; messages: UIMessage[] }

export type ParseAgentChatResult = { ok: true; request: AgentChatRequest } | { ok: false; status: 400 | 413 }

/**
 * Parse a `DefaultChatTransport` body into a history safe to send to the model. Client system messages,
 * tool parts, and reasoning parts are dropped; oversized bodies, too many messages, and unknown part types are rejected.
 */
export const parseAgentChatRequest = (rawBody: string): ParseAgentChatResult => {
  // Backstop for chunked bodies, which carry no Content-Length.
  if (Buffer.byteLength(rawBody) > maxRequestBytes) {
    return { ok: false, status: 413 }
  }
  const parsed = requestSchema.safeParse(parseJson(rawBody))
  if (!parsed.success) {
    return { ok: false, status: 400 }
  }
  const messages = parsed.data.messages.flatMap(({ id, role, parts }) => {
    const replayable = parts.filter((part) => part !== null)
    return role === 'system' || replayable.length === 0 ? [] : [{ id, role, parts: replayable }]
  })
  if (messages.length === 0) {
    return { ok: false, status: 400 }
  }
  return { ok: true, request: { id: parsed.data.id, messages } }
}
