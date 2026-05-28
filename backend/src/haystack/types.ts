/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from 'zod'

/**
 * Haystack pipeline descriptor as configured via the `HAYSTACK_PIPELINES`
 * environment variable. The variable is a JSON array of these objects. Each
 * pipeline becomes one {@link RemoteAgentDescriptor} on `GET /agents`.
 *
 * Deepset Cloud surfaces pipelines under two identifiers:
 *  - `pipelineName` — URL slug used in `/pipelines/${pipelineName}/chat-stream`.
 *  - `pipelineId`   — the workspace-scoped UUID, used as the `pipeline_id`
 *                     body field when bootstrapping a `search_session`.
 *
 * We keep them as separate fields because Deepset can rename a pipeline (slug
 * changes) without re-issuing its UUID, and vice versa.
 *
 *  - `id`          — public slug we surface to the FE (`rag-chat`, etc). The
 *                    only identifier the FE sees.
 *  - `name`        — human-readable label for the agent picker.
 *  - `pipelineName`— Deepset URL slug.
 *  - `pipelineId`  — Deepset UUID.
 *  - `description` — optional one-line description shown in the picker.
 *  - `icon`        — optional Phosphor icon name; defaults applied by the
 *                    provider when omitted.
 */
export const haystackPipelineDescriptorSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  pipelineName: z.string().min(1),
  pipelineId: z.string().min(1),
  description: z.string().optional(),
  icon: z.string().optional(),
})

export type HaystackPipelineDescriptor = z.infer<typeof haystackPipelineDescriptorSchema>

export const haystackPipelinesEnvSchema = z.array(haystackPipelineDescriptorSchema)

/**
 * SSE event types emitted by Deepset's `/chat-stream` endpoint. Mirrors the
 * shape exercised by Deepset Cloud production traffic and the upstream
 * reference client (PR #531 `backend/src/haystack/client.ts:parseSSE`):
 *
 *  - `{ type: "delta", delta: { text: string } }`  — partial answer chunk.
 *  - `{ type: "result", result: <DeepsetResultPayload> }` — final answers +
 *    documents with `_references` to source documents.
 *  - `{ type: "error", message: string }` — upstream surface error.
 *  - `data: [DONE]` — sentinel line terminating the stream (no JSON object).
 *
 * The normalized event surface we propagate to the ACP server collapses these
 * to a discriminated union; we lose the original envelope shape but preserve
 * every load-bearing field.
 */
const deepsetReferenceSchema = z.object({
  document_position: z.number(),
  document_id: z.string(),
})

const deepsetFileSchema = z.object({
  id: z.string(),
  name: z.string(),
})

const deepsetAnswerSchema = z.object({
  answer: z.string(),
  files: z.array(deepsetFileSchema).default([]),
  meta: z
    .object({
      _references: z.array(deepsetReferenceSchema).default([]),
    })
    .partial()
    .optional(),
})

const deepsetDocumentSchema = z.object({
  id: z.string(),
  content: z.string(),
  score: z.number(),
  file: deepsetFileSchema,
  meta: z
    .object({
      page_number: z.number().optional(),
    })
    .passthrough()
    .optional(),
})

export const deepsetResultPayloadSchema = z.object({
  answers: z.array(deepsetAnswerSchema).default([]),
  documents: z.array(deepsetDocumentSchema).default([]),
})

export type DeepsetResultPayload = z.infer<typeof deepsetResultPayloadSchema>

/**
 * Normalized SSE event surface the parser yields. The Deepset envelope
 * (`{type, delta:{text}, ...}`) is collapsed here so downstream code never
 * touches raw upstream shapes.
 */
export const haystackEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('delta'),
    text: z.string(),
  }),
  z.object({
    type: z.literal('result'),
    result: deepsetResultPayloadSchema,
  }),
  z.object({
    type: z.literal('error'),
    error: z.string(),
  }),
  z.object({
    type: z.literal('done'),
  }),
])

export type HaystackEvent = z.infer<typeof haystackEventSchema>

/** Reference metadata extracted from a Deepset result for ACP `_meta`. */
export type HaystackReferenceMeta = {
  position: number
  fileId: string
  fileName: string
  pageNumber?: number
}

/** Document metadata extracted from a Deepset result for ACP `_meta`. */
export type HaystackDocumentMeta = {
  id: string
  content: string
  score: number
  file: { id: string; name: string }
}

/** Per-session in-memory state for an open Haystack ACP connection. */
export type HaystackSessionContext = {
  /** ACP session id (UUID generated on `session/new`). */
  sessionId: string
  /** Deepset pipeline UUID (used for `search_session` bootstrap). */
  pipelineId: string
  /** Deepset pipeline URL slug (used for `/chat-stream`). */
  pipelineName: string
  /**
   * Deepset `search_session_id`, lazily bootstrapped on the first prompt.
   * Reused across prompts so multi-turn chat history is preserved upstream.
   */
  searchSessionId: string | null
  /**
   * AbortController scoped to the currently running prompt turn. `null` when
   * the session is idle. Replaced on every `session/prompt` so cancelling one
   * turn never poisons subsequent turns on the same session.
   */
  currentTurnAbort: AbortController | null
}
