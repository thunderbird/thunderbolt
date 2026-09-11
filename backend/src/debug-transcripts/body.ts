/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { debugTranscriptNoteMaxLength } from '@shared/debug-transcript-contract'
import { z } from 'zod'

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
)

/** What the app sends to its own deployment. Mirrors the TypeBox shape the route used before. */
export const debugTranscriptSubmissionSchema = z
  .object({
    threadId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/),
    schemaVersion: z.number().int().min(1).max(1000),
    payload: z.record(z.string(), jsonValueSchema),
    userNote: z.string().max(debugTranscriptNoteMaxLength).optional(),
    clientVersion: z.string().max(100).optional(),
  })
  .strict()

/** What a relay sends to the intake: the submission plus the submitting user's id in the relay's database. */
export const debugTranscriptIntakeBodySchema = debugTranscriptSubmissionSchema.extend({
  userId: z.string().max(100).nullable(),
})

export type DebugTranscriptSubmission = z.infer<typeof debugTranscriptSubmissionSchema>
export type DebugTranscriptIntakeBody = z.infer<typeof debugTranscriptIntakeBodySchema>

export type BoundedJsonResult = { ok: true; value: unknown } | { ok: false; reason: 'too_large' | 'invalid' }

/**
 * Read a JSON request body while counting bytes, so a chunked upload without
 * `content-length` cannot make the server buffer more than `maxBytes`.
 */
export const readBoundedJson = async (request: Request, maxBytes: number): Promise<BoundedJsonResult> => {
  const reader = request.body?.getReader()
  if (!reader) {
    return { ok: false, reason: 'invalid' }
  }
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      return { ok: false, reason: 'too_large' }
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  } catch {
    return { ok: false, reason: 'invalid' }
  }
}
