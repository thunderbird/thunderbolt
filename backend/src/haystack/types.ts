/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from 'zod'

/**
 * Haystack pipeline descriptor as configured via the `HAYSTACK_PIPELINES`
 * environment variable. The variable is a JSON array of these objects. Each
 * pipeline becomes one {@link RemoteAgentDescriptor} on `GET /agents`.
 *
 * - `id`: stable agent id surfaced to the frontend (`haystack-rag` etc.).
 * - `name`: human-readable label.
 * - `pipelineId`: the Haystack-side identifier we POST to `/runs`. Distinct
 *   from `id` so the public agent surface stays portable when Haystack renames
 *   pipelines server-side.
 * - `description`: optional one-line description shown in the agent picker.
 */
export const haystackPipelineDescriptorSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  pipelineId: z.string().min(1),
  description: z.string().optional(),
})

export type HaystackPipelineDescriptor = z.infer<typeof haystackPipelineDescriptorSchema>

export const haystackPipelinesEnvSchema = z.array(haystackPipelineDescriptorSchema)

/**
 * Subset of a Haystack `/runs` SSE event the adapter understands. Haystack
 * emits a stream of `data: {...}\n\n` lines; we validate each one with this
 * schema before forwarding to the ACP client.
 *
 * The Haystack streaming wire is intentionally narrow here — we accept only
 * the event types we know how to translate today (`delta` and `done`).
 * Anything else is rejected loudly via Zod so silent breakage at the upstream
 * surface is impossible.
 *
 * Fields:
 *  - `type`: discriminator. `delta` ships a partial text chunk; `done` signals
 *    end-of-stream and carries an optional `stopReason`.
 *  - `text`: the partial text content for `delta` events (required there).
 *  - `stopReason`: optional. When present on `done`, the ACP server forwards
 *    it as the `PromptResponse.stopReason`. Default is `end_turn`.
 *  - `error`: optional string for `error` events; the WS closes the prompt
 *    turn with `refusal` after surfacing the error chunk.
 */
export const haystackEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('delta'),
    text: z.string(),
  }),
  z.object({
    type: z.literal('done'),
    stopReason: z.enum(['end_turn', 'max_tokens', 'refusal', 'cancelled']).optional(),
  }),
  z.object({
    type: z.literal('error'),
    error: z.string(),
  }),
])

export type HaystackEvent = z.infer<typeof haystackEventSchema>

/** Per-session in-memory state for an open Haystack ACP connection. */
export type HaystackSessionContext = {
  /** ACP session id (UUID generated on `session/new`). */
  sessionId: string
  /** Pipeline id selected by the `?pipeline=` query parameter. */
  pipelineId: string
  /** Abort controller that cancels the upstream `/runs` request. */
  abort: AbortController
}
