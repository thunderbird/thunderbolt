/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { debugTranscriptNoteMaxLength } from '@shared/debug-transcript-contract'
import { z } from 'zod'

/** What the app sends to its own deployment. Mirrors the TypeBox shape the route used before. */
export const debugTranscriptSubmissionSchema = z
  .object({
    threadId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/),
    schemaVersion: z.number().int().min(1).max(1000),
    payload: z.record(z.string(), z.json()),
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
