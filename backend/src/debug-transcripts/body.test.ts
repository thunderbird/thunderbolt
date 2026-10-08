/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { debugTranscriptIntakeBodySchema, debugTranscriptSubmissionSchema } from './body'

describe('body schemas', () => {
  const valid = { threadId: 'thread-1', schemaVersion: 1, payload: { turns: [] } }

  it('accepts a submission and rejects unknown top-level fields', () => {
    expect(debugTranscriptSubmissionSchema.safeParse(valid).success).toBe(true)
    expect(debugTranscriptSubmissionSchema.safeParse({ ...valid, userId: 'spoof' }).success).toBe(false)
  })

  it('requires userId (string or null) on the intake body', () => {
    expect(debugTranscriptIntakeBodySchema.safeParse(valid).success).toBe(false)
    expect(debugTranscriptIntakeBodySchema.safeParse({ ...valid, userId: null }).success).toBe(true)
    expect(debugTranscriptIntakeBodySchema.safeParse({ ...valid, userId: 'u1' }).success).toBe(true)
  })
})
