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
 * Parts the client may replay: text only (see `isHostedAgentPartType` in `@shared/hosted-agent-history`). Each
 * schema rebuilds the part from known fields only, so client-forged `providerMetadata` never reaches the
 * provider. Blank text parts are dropped (see `isBlankTextPart`).
 */
const textPartSchema = z
  .object({ type: z.literal('text'), text: z.string() })
  .transform((part) => (isBlankTextPart(part) ? null : part))

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

/** A role's replayed parts, checked against the shared per-role rule. Files never get here: `containsFilePart`
 *  refuses them first, with their own reason. */
const partsSchemaFor = (role: 'user' | 'assistant') =>
  z
    .array(z.union([textPartSchema, droppedPartSchema]))
    .transform(withoutDroppedParts)
    .refine((parts) => parts.every((part) => isHostedAgentPartType(role, part.type)))

const messageSchema = z.discriminatedUnion('role', [
  z.object({ id: z.string(), role: z.literal('user'), parts: partsSchemaFor('user') }),
  z.object({ id: z.string(), role: z.literal('assistant'), parts: partsSchemaFor('assistant') }),
  // Client system messages are dropped whole, so their parts are never inspected.
  z.object({ id: z.string(), role: z.literal('system'), parts: z.array(z.unknown()) }),
])

/**
 * Longest `instructions` string, in UTF-16 code units. The 2 MB body cap (`maxRequestBytes`) is sized for a
 * long history, and the system prompt rides every turn on top of it, so it gets a tighter bound of its own:
 * a project at its own cap (`maxProjectInstructionsLength`, 20,000) plus room for several `/slug` skills,
 * at most about 150 KB of UTF-8.
 */
export const maxAgentInstructionsLength = 50_000

const requestSchema = z.object({
  id: z.string(),
  messages: z.array(messageSchema).max(maxHostedAgentHistoryMessages),
  instructions: z.string().max(maxAgentInstructionsLength).optional(),
})

/** Whether a failed parse failed only on `instructions` being too long, which gets its own reason. */
const isInstructionsTooLong = (error: z.ZodError): boolean =>
  error.issues.every((issue) => issue.path[0] === 'instructions' && issue.code === 'too_big')

export type AgentChatRequest = { id: string; messages: UIMessage[]; instructions?: string }
export type AgentChatParseResult =
  | { ok: true; value: AgentChatRequest }
  | { ok: false; reason: 'invalid' | 'files_unsupported' | 'instructions_too_large' }

/**
 * Parse a `DefaultChatTransport` body into a history safe to send to the model. Client system messages and
 * the parts above are dropped. A file part anywhere is refused as `files_unsupported`, before any of the shared
 * rules from `@shared/hosted-agent-history` run. Too many messages and unknown part types are `invalid`, as is
 * a history that does not start and end with a user message (see `startsAndEndsOnUserMessage`). `instructions`
 * longer than {@link maxAgentInstructionsLength} is `instructions_too_large` when nothing else is wrong. The
 * byte cap is enforced earlier, while the body is read (see `readBoundedJson`).
 */
export const parseAgentChatRequest = (body: unknown): AgentChatParseResult => {
  if (containsFilePart(body)) {
    return { ok: false, reason: 'files_unsupported' }
  }
  const parsed = requestSchema.safeParse(body)
  if (!parsed.success) {
    return { ok: false, reason: isInstructionsTooLong(parsed.error) ? 'instructions_too_large' : 'invalid' }
  }
  const messages = parsed.data.messages.flatMap((message) => {
    if (message.role === 'system') {
      return []
    }
    return message.parts.length === 0 ? [] : [{ id: message.id, role: message.role, parts: message.parts }]
  })
  if (!startsAndEndsOnUserMessage(messages)) {
    return { ok: false, reason: 'invalid' }
  }
  return { ok: true, value: { id: parsed.data.id, messages, instructions: parsed.data.instructions } }
}
