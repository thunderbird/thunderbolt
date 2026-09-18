/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { debugTranscriptIntakeBodySchema, debugTranscriptSubmissionSchema, readBoundedJson } from './body'

const chunked = (text: string, chunkSize = 1024): Request => {
  const bytes = new TextEncoder().encode(text)
  let offset = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close()
        return
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize))
      offset += chunkSize
    },
  })
  // No content-length: the server must count bytes as they arrive.
  return new Request('http://localhost/x', { method: 'POST', body, duplex: 'half' } as RequestInit)
}

describe('readBoundedJson', () => {
  it('parses a small chunked body', async () => {
    expect(await readBoundedJson(chunked('{"a":1}'), 100)).toEqual({ ok: true, value: { a: 1 } })
  })

  it('stops reading once the running total passes the cap', async () => {
    const big = `{"a":"${'x'.repeat(5000)}"}`
    expect(await readBoundedJson(chunked(big), 2048)).toEqual({ ok: false, reason: 'too_large' })
  })

  it('reports invalid JSON', async () => {
    expect(await readBoundedJson(chunked('{nope'), 100)).toEqual({ ok: false, reason: 'invalid' })
  })
})

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
