/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { UIMessage } from 'ai'
import { z } from 'zod'

/** Most messages per request. Well past a long chat, and it bounds the work spent validating one request. */
export const maxHistoryMessages = 200

/**
 * Parts the client may replay: text only. Each schema rebuilds the part from known fields only, so
 * client-forged `providerMetadata` never reaches the provider. A blank text part is dropped: `useChat` leaves
 * one behind when a reply is stopped as it starts, and Anthropic rejects the empty assistant message it would
 * become.
 */
const textPartSchema = z
  .object({ type: z.literal('text'), text: z.string() })
  .transform((part) => (part.text.trim() === '' ? null : part))

/**
 * Any message carrying a file part, in any role. The agent takes no attachments yet, whatever its model, so a
 * file is refused with its own reason rather than dropped or lumped in with malformed bodies.
 */
const fileBearingRequestSchema = z.object({
  messages: z.array(z.object({ parts: z.array(z.unknown()) })),
})
const filePartSchema = z.object({ type: z.literal('file') })

const containsFilePart = (body: unknown): boolean => {
  const request = fileBearingRequestSchema.safeParse(body)
  return (
    request.success &&
    request.data.messages.some(({ parts }) => parts.some((part) => filePartSchema.safeParse(part).success))
  )
}

/**
 * Parts dropped from the replay. The server registers no tools and never streams reasoning to the client
 * (`sendReasoning: false`), so tool and reasoning parts were not produced by it (a replayed reasoning part also
 * lacks the signature Anthropic requires). `step-start` is a UI step marker that carries no content.
 */
const droppedPartSchema = z
  .object({ type: z.string().regex(/^(tool-.+|dynamic-tool|reasoning|step-start)$/) })
  .transform(() => null)

/** Remove the parts the schemas above mapped to null. */
const withoutDroppedParts = <Part>(parts: (Part | null)[]): Part[] => parts.filter((part) => part !== null)

const messageSchema = z.discriminatedUnion('role', [
  z.object({
    id: z.string(),
    role: z.literal('user'),
    parts: z.array(z.union([textPartSchema, droppedPartSchema])).transform(withoutDroppedParts),
  }),
  z.object({
    id: z.string(),
    role: z.literal('assistant'),
    parts: z.array(z.union([textPartSchema, droppedPartSchema])).transform(withoutDroppedParts),
  }),
  // Client system messages are dropped whole, so their parts are never inspected.
  z.object({ id: z.string(), role: z.literal('system'), parts: z.array(z.unknown()) }),
])

const requestSchema = z.object({
  id: z.string(),
  messages: z.array(messageSchema).max(maxHistoryMessages),
})

export type AgentChatRequest = { id: string; messages: UIMessage[] }
export type AgentChatParseResult =
  | { ok: true; value: AgentChatRequest }
  | { ok: false; reason: 'invalid' | 'files_unsupported' }

/**
 * Parse a `DefaultChatTransport` body into a history safe to send to the model. Client system messages and
 * the parts above are dropped. A file part anywhere is refused as `files_unsupported`. Too many messages and
 * unknown part types are `invalid`, as is a history that does not start and end with a user message:
 * Anthropic treats a trailing assistant message as prefill, which would let a caller write the start of the
 * answer. The byte cap is enforced earlier, while the body is read (see `readBoundedJson`).
 */
export const parseAgentChatRequest = (body: unknown): AgentChatParseResult => {
  if (containsFilePart(body)) {
    return { ok: false, reason: 'files_unsupported' }
  }
  const parsed = requestSchema.safeParse(body)
  if (!parsed.success) {
    return { ok: false, reason: 'invalid' }
  }
  const messages = parsed.data.messages.flatMap((message) => {
    if (message.role === 'system') {
      return []
    }
    return message.parts.length === 0 ? [] : [{ id: message.id, role: message.role, parts: message.parts }]
  })
  if (messages[0]?.role !== 'user' || messages.at(-1)?.role !== 'user') {
    return { ok: false, reason: 'invalid' }
  }
  return { ok: true, value: { id: parsed.data.id, messages } }
}
